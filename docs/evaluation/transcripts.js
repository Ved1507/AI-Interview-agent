// Synthetic candidate answers for the Mode A evaluation (job: cloud_architect, 5 bank questions).
// Each array has one answer per bank question, in bank order.
module.exports = {
  T1_strong: [
    "I start with the business outcomes and the constraints, such as data residency and uptime targets. For a recent product I split the platform into separate AWS accounts for production, staging and shared services, with a transit gateway for networking. I recorded each main trade-off in a decision record: a managed database instead of self-run for backups and patching, accepting a higher unit cost, and a single region with a documented disaster recovery plan to a second region rather than active-active, because the recovery time target allowed it. The records were reviewed with the security and finance leads before build.",
    "I would first inventory dependencies using traffic logs and a configuration database export, then group workloads by how tightly they are coupled. I move the lowest-risk, least-coupled services first, to prove the landing zone and the delivery pipeline. For the core policy system I used three phases with parallel running: the new stack received shadow traffic, we compared outputs for two billing cycles, then cut over per customer segment. The success criteria were agreed upfront: output parity above 99.9 percent, latency within 10 percent of the old system, and a tested rollback under 30 minutes.",
    "Every account gets mandatory cost allocation tags, enforced by policy, and each team has a monthly budget with alerts at 80 percent. We run a weekly review of the top ten cost movers. For design decisions I ask teams to state the expected monthly cost and the cost per transaction in the design review. On one platform, rightsizing and reserved capacity cut spend by about 25 percent, and cost per transaction was the metric we tracked against business growth.",
    "Production and development sit in separate accounts with no direct network routes between them. Traffic passes through a transit gateway with route tables that allow only named paths. Access is by role with least privilege, and break-glass access to production needs a ticket, a time-limited role and an audit log that is reviewed each week. Network rules are written as code in Terraform and tested in the pipeline, so a rule that opens development to production fails the build.",
    "I start with a short review covering data classification, security controls, the support model and an exit plan. I write a reference pattern with a working example and a checklist, so the next team does not start from zero. The decision is recorded in a short architecture record that names an owner for the service and sets a review date, so the service does not become a one-team exception.",
  ],
  T2_average: [
    "I used AWS and split things into a few accounts. We used a load balancer and some containers. I think I wrote the main decisions down in a document, mostly about cost and which region to use.",
    "We moved the less important servers first and then the main system. We tested it before switching over. I think we had a rollback plan if something went wrong.",
    "We tagged resources so teams could see their own costs, and we looked at the bill every month. Sometimes we turned off unused things. Teams were asked to keep an eye on their spending.",
    "We separated production and development into different accounts. Access is controlled with roles. For production debugging, engineers request access and it is approved by a lead.",
    "I would check that the service is secure and that someone will support it, then approve it if it looks fine. I would share what we learned with the other teams.",
  ],
  T3_weak: [
    "I just use the cloud, it is easy. I put the app on AWS and it works. I did not really write anything down.",
    "I would move everything to the cloud at once because it is faster. Testing is not that important if the servers are the same.",
    "Cost is not really my problem, finance looks at the bill. We just pay it.",
    "We have one network for everything. It is fine because everyone is in the same company.",
    "I say yes or no. If it is new we usually say no because it is risky.",
  ],
  T4_mixed: [
    "Aurora global database with a secondary region, recovery point around a minute, and the recovery time target was fifteen minutes but we never tested it properly. Separate VPC per environment, cross-account roles with service control policies, infrastructure as code in Terraform with a module per workload, and a nightly plan to catch drift. Aurora over DynamoDB because our queries are relational, and I accepted the cost of cross-region replication. I can't say exactly where the decisions were written down, it was in the team wiki somewhere, I think.",
    "So the approach was the strangler pattern with an API gateway routing by path. We moved read paths first, then writes behind a feature flag, with dual writes and a reconciliation job for two weeks. Change data capture from the old Oracle database using a migration service, parity checks on row counts and checksums, and cut over when the checks were clean. Anyway, lift and shift on its own would have been a mistake.",
    "Budgets per account, anomaly detection on the cost reports, savings plans for steady load and spot instances for batch work. Unit cost per order is on a dashboard, and teams receive chargeback reports, which, to be honest, they did not read at first, so we had a meeting about it.",
    "Separate accounts, a service control policy that denies public subnets in production, private links for the software-as-a-service tools, security findings sent to a central hub, just-in-time access through identity center, and break-glass access with a second approver. The audit log goes to a central account. It is all in the landing zone repository, documented in there.",
    "A checklist: data classification, the identity model, logging, the cost model and the exit route. Then a pilot in a sandbox, a reference module, and a field for who owns it. Then a review meeting. I'm not sure how it works with other teams because we did it mostly alone.",
  ],
  T5_short: [
    "AWS, using VPCs.",
    "Lift and shift.",
    "Tags.",
    "Separate accounts.",
    "Check it first.",
  ],
};
