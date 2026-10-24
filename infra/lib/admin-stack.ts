import {
  CfnOutput,
  CfnParameter,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { DATABASE_NAME, type DataStack } from "./data-stack";

// The ECS cluster and the one-off admin task (same image as the app): database
// migrations and the first admin. Deployed and run BEFORE the web app, on every
// release, so the schema and the app's database login exist before new code starts.

export const RDS_CA = "/app/certs/rds-global-bundle.pem";

export interface AdminStackProps extends StackProps {
  data: DataStack;
}

export class AdminStack extends Stack {
  readonly cluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);
    const { data } = props;

    const imageTag = new CfnParameter(this, "ImageTag", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
      description: "Tag of the image the CodeBuild project pushed (the git commit).",
    });

    this.cluster = new ecs.Cluster(this, "Cluster", { clusterName: "nf-attendance", vpc: data.vpc });

    const executionRole = new iam.Role(this, "AdminTaskExecutionRole", {
      description: "Pulls the image, writes logs and reads the database owner and runtime logins for admin tasks",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });

    // The admin scripts call no AWS API, so their task role has no permissions at all.
    // Declared explicitly (CDK would otherwise add an unnamed default role); both role
    // names start with "NfAttendance-Admin-AdminTask", which the deployer may pass to ECS.
    const taskRole = new iam.Role(this, "AdminTaskRole", {
      description: "Role of the admin task's code: no AWS permissions",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    const logGroup = new logs.LogGroup(this, "AdminTaskLogs", {
      logGroupName: "/nf-attendance/admin-tasks",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const task = new ecs.FargateTaskDefinition(this, "AdminTask", {
      family: "nf-attendance-admin",
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });
    task.addContainer("admin", {
      containerName: "admin",
      image: ecs.ContainerImage.fromRegistry(`${data.repository.repositoryUri}:${imageTag.valueAsString}`),
      // Without an override this only prints the migration plan and changes nothing.
      command: ["node", "scripts/db/migrate.mjs"],
      environment: {
        DB_HOST: data.database.instanceEndpoint.hostname,
        DB_PORT: "5432",
        DB_NAME: DATABASE_NAME,
        DATABASE_SSL: "verify-full",
        DATABASE_SSL_CA: RDS_CA,
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(data.ownerSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(data.ownerSecret, "password"),
        DB_RUNTIME_USER: ecs.Secret.fromSecretsManager(data.runtimeSecret, "username"),
        DB_RUNTIME_PASSWORD: ecs.Secret.fromSecretsManager(data.runtimeSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "admin" }),
    });
    data.repository.grantPull(executionRole);

    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "AdminTaskDefinition", { value: task.taskDefinitionArn });
    new CfnOutput(this, "AdminTaskLogGroup", { value: logGroup.logGroupName });
  }
}
