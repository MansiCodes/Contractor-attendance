import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AdminStack } from "../lib/admin-stack";
import { AppStack } from "../lib/app-stack";
import { DataStack } from "../lib/data-stack";

// Security and cost properties of the synthesised CloudFormation. No AWS access.

const app = new App();
const env = { region: "ap-south-1" };
const dataStack = new DataStack(app, "Data", { env });
const adminStack = new AdminStack(app, "Admin", { env, data: dataStack });
const appStack = new AppStack(app, "Web", { env, data: dataStack, admin: adminStack });
const data = Template.fromStack(dataStack);
const admin = Template.fromStack(adminStack);
const web = Template.fromStack(appStack);

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;
const resourcesOf = (t: Template, type: string) =>
  Object.entries(t.toJSON().Resources as Resources).filter(([, r]) => r.Type === type);
const json = (v: unknown) => JSON.stringify(v);

describe("network and cost", () => {
  it("has no NAT gateway and keeps the database in isolated subnets", () => {
    data.resourceCountIs("AWS::EC2::NatGateway", 0);
    const subnets = resourcesOf(data, "AWS::EC2::Subnet");
    assert.equal(subnets.length, 4);
    // Only the two public subnets get a default route to the internet.
    data.resourceCountIs("AWS::EC2::Route", 2);
  });

  it("uses a small single-AZ database by default", () => {
    data.hasResourceProperties("AWS::RDS::DBInstance", { DBInstanceClass: "db.t4g.micro", AllocatedStorage: "20", MaxAllocatedStorage: 100, StorageType: "gp3" });
    data.hasParameter("DatabaseMultiAz", { Default: "false" });
  });
});

describe("database", () => {
  it("is private, encrypted, deletion-protected, backed up for 7 days and retained as a snapshot", () => {
    data.hasResource("AWS::RDS::DBInstance", {
      Properties: Match.objectLike({
        Engine: "postgres",
        PubliclyAccessible: false,
        StorageEncrypted: true,
        DeletionProtection: true,
        BackupRetentionPeriod: 7,
        EnableCloudwatchLogsExports: ["postgresql"],
      }),
      DeletionPolicy: "Snapshot",
      UpdateReplacePolicy: "Snapshot",
    });
  });

  it("requires TLS for every connection", () => {
    data.hasResourceProperties("AWS::RDS::DBParameterGroup", { Parameters: Match.objectLike({ "rds.force_ssl": "1" }) });
  });

  it("accepts PostgreSQL only from the app security group, never from an address range", () => {
    const ingress = resourcesOf(data, "AWS::EC2::SecurityGroupIngress");
    assert.equal(ingress.length, 1);
    const [, rule] = ingress[0];
    assert.equal(rule.Properties?.FromPort, 5432);
    assert.equal(rule.Properties?.ToPort, 5432);
    assert.match(json(rule.Properties?.SourceSecurityGroupId), /AppSecurityGroup/);
    for (const [, sg] of resourcesOf(data, "AWS::EC2::SecurityGroup")) {
      assert.equal(sg.Properties?.SecurityGroupIngress, undefined, "no inline ingress rules");
    }
  });
});

describe("storage and images", () => {
  it("blocks all public access on every bucket and denies non-TLS requests", () => {
    const buckets = resourcesOf(data, "AWS::S3::Bucket");
    assert.equal(buckets.length, 2);
    for (const [, b] of buckets) {
      assert.deepEqual(b.Properties?.PublicAccessBlockConfiguration, {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
    const policies = resourcesOf(data, "AWS::S3::BucketPolicy");
    assert.equal(policies.length, 2);
    for (const [, p] of policies) {
      assert.match(json(p.Properties?.PolicyDocument), /"aws:SecureTransport":"false"/);
      assert.match(json(p.Properties?.PolicyDocument), /"Effect":"Deny"/);
    }
  });

  it("versions the photo bucket and scans immutable images", () => {
    data.hasResourceProperties("AWS::S3::Bucket", { VersioningConfiguration: { Status: "Enabled" } });
    data.hasResourceProperties("AWS::ECR::Repository", { ImageScanningConfiguration: { ScanOnPush: true }, ImageTagMutability: "IMMUTABLE" });
  });
});

describe("costs and monitoring", () => {
  it("has a monthly budget with actual and forecast alerts", () => {
    data.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetType: "COST", TimeUnit: "MONTHLY" }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }) }),
      ]),
    });
  });

  it("sets a retention period on every log group", () => {
    for (const t of [data, admin, web]) {
      for (const [id, g] of resourcesOf(t, "AWS::Logs::LogGroup")) {
        assert.ok(g.Properties?.RetentionInDays, `${id} has no retention`);
      }
    }
  });
});

describe("web app", () => {
  const service = () => {
    const list = resourcesOf(web, "AWS::ECS::ExpressGatewayService");
    assert.equal(list.length, 1);
    return list[0][1].Properties as {
      PrimaryContainer: { Environment: { Name: string; Value: unknown }[]; Secrets: { Name: string; ValueFrom: unknown }[]; ContainerPort: number };
      HealthCheckPath: string;
      NetworkConfiguration: { Subnets: unknown[]; SecurityGroups: unknown[] };
    };
  };

  it("runs in production mode with verified TLS to the database and S3 storage", () => {
    const env = Object.fromEntries(service().PrimaryContainer.Environment.map((e) => [e.Name, e.Value]));
    assert.equal(env.APP_MODE, "production");
    assert.equal(env.DATABASE_SSL, "verify-full");
    assert.equal(env.DATABASE_SSL_CA, "/app/certs/rds-global-bundle.pem");
    assert.equal(env.STORAGE_DRIVER, "s3");
    assert.equal(service().HealthCheckPath, "/api/health");
    assert.equal(service().PrimaryContainer.ContainerPort, 3000);
  });

  it("passes passwords and keys only as secrets, never as plain settings", () => {
    const { Environment, Secrets } = service().PrimaryContainer;
    for (const e of Environment) assert.doesNotMatch(e.Name, /PASSWORD|SECRET|TOKEN|KEY/, `${e.Name} must be a secret`);
    const names = Secrets.map((s) => s.Name);
    for (const n of ["DATABASE_USER", "DATABASE_PASSWORD", "CRON_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET"]) assert.ok(names.includes(n), `${n} missing`);
  });

  it("keeps WhatsApp live sending and its schedule off by default", () => {
    const env = Object.fromEntries(service().PrimaryContainer.Environment.map((e) => [e.Name, e.Value]));
    assert.deepEqual(env.WHATSAPP_LIVE_SENDING, { Ref: "WhatsAppLiveSending" });
    web.hasParameter("WhatsAppLiveSending", { Default: "disabled" });
    web.hasParameter("WhatsAppScheduleState", { Default: "DISABLED" });
    web.hasResourceProperties("AWS::Scheduler::Schedule", { State: { Ref: "WhatsAppScheduleState" }, ScheduleExpression: "rate(10 minutes)" });
  });

  it("puts the tasks in the public subnets with the app security group (no NAT needed)", () => {
    const net = service().NetworkConfiguration;
    assert.equal(net.Subnets.length, 2);
    assert.match(json(net.SecurityGroups), /AppSecurityGroup/);
  });

  it("limits the app's AWS permissions to contractor photos", () => {
    const policies = resourcesOf(web, "AWS::IAM::Policy").filter(([id]) => id.startsWith("TaskRole"));
    assert.equal(policies.length, 1);
    const doc = json(policies[0][1].Properties?.PolicyDocument);
    assert.match(doc, /contractor-photos\/\*/);
    assert.doesNotMatch(doc, /"s3:\*"|"Action":"\*"/);
  });

  it("keeps the admin task out of the web stack, so migrations can run before the app starts", () => {
    assert.equal(resourcesOf(web, "AWS::ECS::TaskDefinition").length, 0);
    assert.equal(resourcesOf(admin, "AWS::ECS::TaskDefinition").length, 1);
    admin.resourceCountIs("AWS::ECS::Cluster", 1);
    web.resourceCountIs("AWS::ECS::Cluster", 0);
  });

  it("gives the admin task exactly two roles, both passable by the deployer, the task role without permissions", () => {
    const roles = resourcesOf(admin, "AWS::IAM::Role").map(([id]) => id);
    assert.equal(roles.length, 2);
    // Generated role names begin with "<stack>-<logical id>", matched by docs/aws/iam-deployer-policy.json.
    for (const id of roles) assert.match(id, /^AdminTask/);
    const [[, task]] = resourcesOf(admin, "AWS::ECS::TaskDefinition");
    assert.match(json(task.Properties?.TaskRoleArn), /AdminTaskRole[0-9A-F]/);
    assert.match(json(task.Properties?.ExecutionRoleArn), /AdminTaskExecutionRole/);
    const taskRolePolicies = resourcesOf(admin, "AWS::IAM::Policy").filter(([id]) => /^AdminTaskRole[0-9A-F]/.test(id));
    assert.equal(taskRolePolicies.length, 0);
    const policyDoc = readFileSync(join(__dirname, "..", "..", "docs", "aws", "iam-deployer-policy.json"), "utf8");
    assert.ok(policyDoc.includes("role/NfAttendance-Admin-AdminTask*"), "deployer policy must allow passing both admin task roles");
  });

  it("gives the admin task the owner login only through secrets, and only shows the plan by default", () => {
    const [[, task]] = resourcesOf(admin, "AWS::ECS::TaskDefinition");
    const [container] = task.Properties?.ContainerDefinitions as { Environment: { Name: string }[]; Secrets: { Name: string }[]; Command: string[] }[];
    assert.deepEqual(container.Command, ["node", "scripts/db/migrate.mjs"]);
    const secrets = container.Secrets.map((s) => s.Name).sort();
    assert.deepEqual(secrets, ["DB_PASSWORD", "DB_RUNTIME_PASSWORD", "DB_RUNTIME_USER", "DB_USER"]);
    for (const e of container.Environment) assert.doesNotMatch(e.Name, /PASSWORD/);
  });

  it("runs the dispatch Lambda outside the VPC with inline code under the 4 KB limit", () => {
    const [[, fn]] = resourcesOf(web, "AWS::Lambda::Function");
    assert.equal(fn.Properties?.VpcConfig, undefined);
    const code = (fn.Properties?.Code as { ZipFile: string }).ZipFile;
    assert.ok(code.length < 4096, `inline code is ${code.length} bytes`);
    assert.match(code, /exports\.handler/);
  });
});
