import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_scheduler as scheduler,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { RDS_CA, type AdminStack } from "./admin-stack";
import { DATABASE_NAME, type DataStack } from "./data-stack";

// The running app: one ECS Express Mode service (Fargate behind an HTTPS load
// balancer with an AWS-managed certificate) and the WhatsApp dispatch schedule,
// which is created DISABLED. Deploy last: after DataStack, an image build, and the
// AdminStack's migration task (the app's health check needs the migrated database).


export interface AppStackProps extends StackProps {
  data: DataStack;
  admin: AdminStack;
}

/** ECS secret reference to one JSON key of a Secrets Manager secret. */
const jsonKey = (secretArn: string, key: string) => `${secretArn}:${key}::`;

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { data, admin } = props;

    const imageTag = new CfnParameter(this, "ImageTag", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
      description: "Tag of the image the CodeBuild project pushed (the git commit).",
    });
    const liveSending = new CfnParameter(this, "WhatsAppLiveSending", {
      type: "String",
      default: "disabled",
      allowedValues: ["disabled", "enabled"],
      description: "Real WhatsApp sending. Keep 'disabled' until the owner approves and the WhatsApp keys are in the app secret.",
    });
    const scheduleState = new CfnParameter(this, "WhatsAppScheduleState", {
      type: "String",
      default: "DISABLED",
      allowedValues: ["DISABLED", "ENABLED"],
      description: "The 10-minute WhatsApp dispatch schedule. Stays DISABLED until WhatsApp is approved.",
    });

    const image = `${data.repository.repositoryUri}:${imageTag.valueAsString}`;

    // ---------- roles
    const executionRole = new iam.Role(this, "TaskExecutionRole", {
      description: "Pulls the image, writes logs and reads the app's secrets at task start",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });
    data.runtimeSecret.grantRead(executionRole);
    data.appSecret.grantRead(executionRole);

    const taskRole = new iam.Role(this, "TaskRole", {
      description: "What the running app may do in AWS: contractor photos in the private bucket, nothing else",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [data.filesBucket.arnForObjects("contractor-photos/*")],
      }),
    );

    const infrastructureRole = new iam.Role(this, "ExpressInfrastructureRole", {
      description: "Lets ECS Express Mode manage the load balancer, certificate, security groups and scaling",
      assumedBy: new iam.ServicePrincipal("ecs.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSInfrastructureRoleforExpressGatewayServices")],
    });

    // ---------- the web app
    const appLogs = new logs.LogGroup(this, "AppLogs", {
      logGroupName: "/nf-attendance/app",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    appLogs.grantWrite(executionRole);

    const web = new ecs.CfnExpressGatewayService(this, "Web", {
      serviceName: "nf-attendance",
      cluster: admin.cluster.clusterName,
      cpu: "512",
      memory: "1024",
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      infrastructureRoleArn: infrastructureRole.roleArn,
      healthCheckPath: "/api/health",
      networkConfiguration: {
        // Public subnets: internet-facing HTTPS load balancer and public IPs on the
        // tasks (no NAT gateway). The app security group is the one the database admits.
        subnets: data.vpc.publicSubnets.map((s) => s.subnetId),
        securityGroups: [data.appSecurityGroup.securityGroupId],
      },
      scalingTarget: { minTaskCount: 1, maxTaskCount: 2 },
      primaryContainer: {
        image,
        containerPort: 3000,
        awsLogsConfiguration: { logGroup: appLogs.logGroupName, logStreamPrefix: "web" },
        environment: [
          { name: "APP_MODE", value: "production" },
          { name: "DATABASE_HOST", value: data.database.instanceEndpoint.hostname },
          { name: "DATABASE_PORT", value: "5432" },
          { name: "DATABASE_NAME", value: DATABASE_NAME },
          { name: "DATABASE_SSL", value: "verify-full" },
          { name: "DATABASE_SSL_CA", value: RDS_CA },
          { name: "DATABASE_POOL_MAX", value: "5" },
          { name: "STORAGE_DRIVER", value: "s3" },
          { name: "S3_BUCKET", value: data.filesBucket.bucketName },
          { name: "AWS_REGION", value: this.region },
          { name: "WHATSAPP_LIVE_SENDING", value: liveSending.valueAsString },
        ],
        // Passwords and keys only ever arrive as secrets, never as plain settings.
        secrets: [
          { name: "DATABASE_USER", valueFrom: jsonKey(data.runtimeSecret.secretArn, "username") },
          { name: "DATABASE_PASSWORD", valueFrom: jsonKey(data.runtimeSecret.secretArn, "password") },
          { name: "CRON_SECRET", valueFrom: jsonKey(data.appSecret.secretArn, "CRON_SECRET") },
          { name: "WHATSAPP_ACCESS_TOKEN", valueFrom: jsonKey(data.appSecret.secretArn, "WHATSAPP_ACCESS_TOKEN") },
          { name: "WHATSAPP_PHONE_NUMBER_ID", valueFrom: jsonKey(data.appSecret.secretArn, "WHATSAPP_PHONE_NUMBER_ID") },
          { name: "WHATSAPP_APP_SECRET", valueFrom: jsonKey(data.appSecret.secretArn, "WHATSAPP_APP_SECRET") },
          { name: "WHATSAPP_VERIFY_TOKEN", valueFrom: jsonKey(data.appSecret.secretArn, "WHATSAPP_VERIFY_TOKEN") },
        ],
      },
    });
    // The roles' permissions must exist before ECS starts creating the service.
    web.node.addDependency(executionRole, taskRole, infrastructureRole);

    // ---------- WhatsApp dispatch: EventBridge Scheduler -> Lambda -> app (created disabled)
    const dispatchLogs = new logs.LogGroup(this, "DispatchLogs", {
      logGroupName: "/nf-attendance/whatsapp-dispatch",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dispatch = new lambda.Function(this, "WhatsAppDispatch", {
      functionName: "nf-attendance-whatsapp-dispatch",
      description: "Calls the app's /api/whatsapp/dispatch with CRON_SECRET (no state, safe to repeat)",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(readFileSync(join(__dirname, "..", "lambda", "dispatch.cjs"), "utf8")),
      memorySize: 128,
      timeout: Duration.seconds(60),
      logGroup: dispatchLogs,
      environment: { APP_ENDPOINT: web.attrEndpoint, CRON_SECRET_ARN: data.appSecret.secretArn },
    });
    data.appSecret.grantRead(dispatch);
    dispatch.configureAsyncInvoke({ retryAttempts: 1, maxEventAge: Duration.minutes(10) });

    const schedulerRole = new iam.Role(this, "DispatchSchedulerRole", {
      description: "Lets EventBridge Scheduler invoke the WhatsApp dispatch function",
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": this.account } } }),
    });
    dispatch.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, "WhatsAppDispatchSchedule", {
      name: "nf-attendance-whatsapp-dispatch",
      description: "Runs the WhatsApp dispatch every 10 minutes (the app decides what, if anything, to send)",
      scheduleExpression: "rate(10 minutes)",
      flexibleTimeWindow: { mode: "OFF" },
      state: scheduleState.valueAsString,
      target: {
        arn: dispatch.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 600 },
      },
    });

    const dispatchErrors = new cloudwatch.Alarm(this, "DispatchErrors", {
      metric: dispatch.metricErrors({ period: Duration.hours(1) }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "WhatsApp dispatch failed 3 or more times in an hour",
    });
    dispatchErrors.addAlarmAction(new cwActions.SnsAction(data.alertsTopic));

    // ---------- outputs used by the deployment guide
    new CfnOutput(this, "AppUrl", { value: web.attrEndpoint, description: "HTTPS address of the app" });
  }
}
