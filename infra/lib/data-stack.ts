import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_codebuild as codebuild,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

// Everything that holds data or must exist before the app: network, database,
// secrets, file storage, the image registry and the image build, cost and health
// alerts. Deploy this stack first; nothing here runs the app.
//
// Costs to watch (Mumbai): the database instance runs all month; public IPv4
// addresses are charged hourly; there is deliberately no NAT gateway.

export const DATABASE_NAME = "nf_attendance";
export const RUNTIME_DB_USER = "nf_app";
const DB_INSTANCE_ID = "nf-attendance-db";

export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly database: rds.DatabaseInstance;
  readonly ownerSecret: secretsmanager.ISecret;
  readonly runtimeSecret: secretsmanager.Secret;
  readonly appSecret: secretsmanager.Secret;
  readonly filesBucket: s3.Bucket;
  readonly repository: ecr.Repository;
  readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const alertEmail = new CfnParameter(this, "AlertEmail", {
      type: "String",
      description: "Email that receives budget and health alerts (confirm the subscription email AWS sends).",
      allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      constraintDescription: "must be an email address",
    });
    const monthlyBudget = new CfnParameter(this, "MonthlyBudgetUsd", {
      type: "Number",
      default: 90,
      minValue: 10,
      description: "Monthly AWS cost (USD, before tax) that triggers budget alerts: 80% actual and 100% forecast.",
    });
    const multiAz = new CfnParameter(this, "DatabaseMultiAz", {
      type: "String",
      default: "false",
      allowedValues: ["false", "true"],
      description: "true keeps a standby database in a second zone (about double the database cost, no downtime during maintenance).",
    });

    // ---------- network: public subnets for the load balancer and app tasks, isolated subnets for the database
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.20.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "database", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Free: S3 traffic from the tasks stays on the AWS network.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    // The app and the one-off admin tasks carry this group. It allows no inbound
    // traffic by itself; ECS Express Mode adds the load balancer's own path.
    this.appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
      vpc: this.vpc,
      description: "NF attendance app and admin tasks (no inbound rules of its own)",
      allowAllOutbound: true,
    });
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc: this.vpc,
      description: "NF attendance database: PostgreSQL from the app security group only",
      allowAllOutbound: false,
    });
    dbSecurityGroup.addIngressRule(this.appSecurityGroup, ec2.Port.tcp(5432), "PostgreSQL from the app and admin tasks");

    // ---------- database: PostgreSQL 18 (the version the test suite runs on), private, encrypted, TLS only
    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18 });
    const parameters = new rds.ParameterGroup(this, "DatabaseParameters", {
      engine,
      description: "NF attendance: TLS required, slow statements logged",
      parameters: {
        "rds.force_ssl": "1",
        log_min_duration_statement: "2000",
      },
    });
    const dbLogs = new logs.LogGroup(this, "DatabaseLogs", {
      logGroupName: `/aws/rds/instance/${DB_INSTANCE_ID}/postgresql`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.database = new rds.DatabaseInstance(this, "Database", {
      instanceIdentifier: DB_INSTANCE_ID,
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      publiclyAccessible: false,
      databaseName: DATABASE_NAME,
      // Owner (master) login: used only by the migration and first-admin tasks.
      credentials: rds.Credentials.fromGeneratedSecret("nf_owner", { secretName: "nf-attendance/db-owner" }),
      parameterGroup: parameters,
      storageType: rds.StorageType.GP3,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      backupRetention: Duration.days(7),
      preferredBackupWindow: "20:30-21:00", // 02:00–02:30 IST
      preferredMaintenanceWindow: "sun:21:30-sun:22:00", // Monday 03:00–03:30 IST
      copyTagsToSnapshot: true,
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ["postgresql"],
      enablePerformanceInsights: false,
    });
    this.database.node.addDependency(dbLogs);
    const useMultiAz = new CfnCondition(this, "UseMultiAz", { expression: Fn.conditionEquals(multiAz.valueAsString, "true") });
    (this.database.node.defaultChild as rds.CfnDBInstance).addPropertyOverride("MultiAZ", Fn.conditionIf(useMultiAz.logicalId, true, false));
    this.ownerSecret = this.database.secret!;

    // The login the app itself connects with. scripts/db/migrate.mjs --runtime-role
    // creates it in PostgreSQL (NOINHERIT; may only switch to authenticated/app_auth).
    this.runtimeSecret = new secretsmanager.Secret(this, "RuntimeDatabaseLogin", {
      secretName: "nf-attendance/db-runtime",
      description: "Database login of the running app (nf_app). Created in PostgreSQL by the migration task.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: RUNTIME_DB_USER }),
        generateStringKey: "password",
        passwordLength: 40,
        excludePunctuation: true,
      },
    });

    // App secrets. CRON_SECRET authorises the scheduled WhatsApp dispatch. The
    // WhatsApp keys stay empty until live sending is approved and configured.
    this.appSecret = new secretsmanager.Secret(this, "AppSecrets", {
      secretName: "nf-attendance/app",
      description: "NF attendance app secrets (CRON_SECRET; WhatsApp Cloud API keys when approved)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          WHATSAPP_ACCESS_TOKEN: "",
          WHATSAPP_PHONE_NUMBER_ID: "",
          WHATSAPP_APP_SECRET: "",
          WHATSAPP_VERIFY_TOKEN: "",
        }),
        generateStringKey: "CRON_SECRET",
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    // ---------- private file storage (contractor photos)
    this.filesBucket = new s3.Bucket(this, "Files", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90), abortIncompleteMultipartUploadAfter: Duration.days(7) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- container images and their build (no Docker needed on the office PC)
    this.repository = new ecr.Repository(this, "Images", {
      repositoryName: "nf-attendance",
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 10, description: "Keep the last 10 images" }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // `git archive` zips of committed files only (no .env, data or worker files) go here.
    const buildSource = new s3.Bucket(this, "BuildSource", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const buildLogs = new logs.LogGroup(this, "ImageBuildLogs", {
      logGroupName: "/nf-attendance/image-build",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const imageBuild = new codebuild.Project(this, "ImageBuild", {
      projectName: "nf-attendance-image",
      description: "Builds the app image from source.zip in the build-source bucket and pushes it to ECR as IMAGE_TAG",
      source: codebuild.Source.s3({ bucket: buildSource, path: "source.zip" }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // needed to run docker build
      },
      environmentVariables: {
        REPOSITORY_URI: { value: this.repository.repositoryUri },
        IMAGE_TAG: { value: "required" }, // overridden when the build is started
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'if [ -z "$IMAGE_TAG" ] || [ "$IMAGE_TAG" = required ]; then echo "Start the build with IMAGE_TAG set (the git commit)"; exit 1; fi',
              'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "${REPOSITORY_URI%%/*}"',
            ],
          },
          build: { commands: ['docker build --platform linux/amd64 -t "$REPOSITORY_URI:$IMAGE_TAG" .'] },
          post_build: { commands: ['docker push "$REPOSITORY_URI:$IMAGE_TAG"'] },
        },
      }),
      timeout: Duration.minutes(30),
      logging: { cloudWatch: { logGroup: buildLogs } },
    });
    this.repository.grantPullPush(imageBuild);

    // ---------- cost and health alerts
    this.alertsTopic = new sns.Topic(this, "Alerts", { displayName: "NF attendance alerts" });
    this.alertsTopic.addSubscription(new subs.EmailSubscription(alertEmail.valueAsString));

    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "nf-attendance-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: monthlyBudget.valueAsNumber, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "EMAIL", address: alertEmail.valueAsString }],
        },
        {
          notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "EMAIL", address: alertEmail.valueAsString }],
        },
      ],
    });

    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, op: cloudwatch.ComparisonOperator, description: string) => {
      const a = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        comparisonOperator: op,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(new cwActions.SnsAction(this.alertsTopic));
    };
    alarm("DatabaseCpuHigh", this.database.metricCPUUtilization({ period: Duration.minutes(5) }), 80, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, "Database CPU above 80% for 15 minutes");
    alarm(
      "DatabaseStorageLow",
      this.database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      2 * 1024 ** 3,
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      "Database free storage below 2 GB",
    );

    // ---------- outputs used by the deployment guide
    new CfnOutput(this, "DatabaseEndpoint", { value: this.database.instanceEndpoint.hostname });
    new CfnOutput(this, "MigrationTarget", {
      value: `${this.database.instanceEndpoint.hostname}/${DATABASE_NAME}`,
      description: "Exact value for migrate.mjs --confirm-target",
    });
    new CfnOutput(this, "PublicSubnets", { value: this.vpc.publicSubnets.map((s) => s.subnetId).join(",") });
    new CfnOutput(this, "AppSecurityGroupId", { value: this.appSecurityGroup.securityGroupId });
    new CfnOutput(this, "FilesBucketName", { value: this.filesBucket.bucketName });
    new CfnOutput(this, "ImageRepositoryUri", { value: this.repository.repositoryUri });
    new CfnOutput(this, "BuildSourceBucketName", { value: buildSource.bucketName });
    new CfnOutput(this, "ImageBuildProject", { value: imageBuild.projectName });
  }
}
