import { App, Tags } from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { AppStack } from "../lib/app-stack";
import { DataStack } from "../lib/data-stack";

// Three stacks, deployed in this order (docs/aws/deployment.md):
//   NfAttendance-Data   network, database, secrets, storage, image registry and build, alerts
//   NfAttendance-Admin  ECS cluster and the one-off admin task (migrations, first admin)
//   NfAttendance-App    the web app and the WhatsApp schedule (disabled)
// On every release: build the image, deploy Admin, run the migrations, then deploy App.
// Synthesising (`npm run synth`) needs no AWS credentials and creates nothing.

const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "ap-south-1",
};

const data = new DataStack(app, "NfAttendance-Data", {
  env,
  description: "NF contractor attendance: network, PostgreSQL, secrets, storage, images, alerts",
  terminationProtection: true,
});
const admin = new AdminStack(app, "NfAttendance-Admin", {
  env,
  data,
  description: "NF contractor attendance: ECS cluster and admin task (migrations, first admin)",
});
new AppStack(app, "NfAttendance-App", {
  env,
  data,
  admin,
  description: "NF contractor attendance: web app (ECS Express Mode) and WhatsApp schedule",
});

Tags.of(app).add("project", "nf-attendance");
