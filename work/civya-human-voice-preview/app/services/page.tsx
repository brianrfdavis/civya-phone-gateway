import Link from "next/link";
import { SiteHeader } from "@/app/components/site-header";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { listWorkflowDefinitions } from "@/lib/workflows/definitions";
import styles from "../launch.module.css";

export const metadata = {
  title: "Wayne County help paths — Civya",
  description: "Five connected, recoverable property-tax assistance paths supported by Civya.",
};

export const dynamic = "force-dynamic";

export default function ServicesPage() {
  const config = getRuntimeConfig();
  const sandbox = config.syntheticMode;
  const workflows = listWorkflowDefinitions();
  return (
    <div className={styles.page}>
      <div className="cv-container">
        <SiteHeader
          nav={<><Link href="/trust">Safety and privacy</Link><Link href="/">Open Civya</Link></>}
          right={<span className="cv-tag teal">{sandbox ? "Fictional preview" : "Controlled launch"}</span>}
        />
        <main id="main" className={styles.main}>
          <section className={styles.hero}>
            <p className={styles.eyebrow}>Five connected help paths</p>
            <h1>One clear next step, with a person when you need one.</h1>
            <p className={styles.lede}>
              {sandbox
                ? "This fictional preview models five connected workflows. Sandbox text and configured browser voice can share saved progress; live County records and operations are not connected here."
                : "Civya keeps progress together across the available web, voice, message, and staff channels. Wayne County and its approved providers remain authoritative for records, decisions, amounts, deadlines, and completion."}
            </p>
            <div className={styles.actions}>
              <Link className="cv-btn cv-btn-primary" href="/">{sandbox ? "Explore the fictional demo" : "Get started"}</Link>
              <Link className="cv-btn cv-btn-ghost" href="/trust">See safety boundaries</Link>
            </div>
          </section>

          <p className={styles.notice} role="note">
            {sandbox ? (
              <><strong>These are design targets, not active County services.</strong> No workflow below reads live Wayne County records, delivers a real reminder, completes a payment or submission, or proves a resident outcome.</>
            ) : (
              <><strong>Controlled-launch service.</strong> Only the channels and providers approved for this deployment are active. A conversation, upload, or browser return never proves a payment, submission, eligibility decision, or completed outcome.</>
            )}
          </p>

          <div className={styles.grid}>
            {workflows.map((workflow, index) => (
              <article className={styles.card} key={workflow.key}>
                <span className={styles.step} aria-hidden="true">{index + 1}</span>
                <h2>{workflow.displayName}</h2>
                <p><strong>{sandbox ? "Planned first step:" : "First step:"}</strong> {workflow.nextActions[workflow.initialState]}</p>
                <p><strong>Completion authority:</strong> {workflow.completionAuthority}.</p>
              </article>
            ))}
          </div>

          <p className={styles.notice} role="note">
            Civya does not replace a statutory County notice, extend a legal deadline, hold payment credentials, or
            treat a conversation, upload, or browser return as proof of completion.
          </p>
        </main>
      </div>
    </div>
  );
}
