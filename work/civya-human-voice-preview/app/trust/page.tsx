import Link from "next/link";
import { SiteHeader } from "@/app/components/site-header";
import { getRuntimeConfig } from "@/lib/config/runtime";
import styles from "../launch.module.css";

export const metadata = {
  title: "Civya safety and privacy — Civya",
  description: "Plain-language safety, privacy, identity, payment, document, and voice boundaries for Civya.",
};

export const dynamic = "force-dynamic";

export default function TrustPage() {
  const config = getRuntimeConfig();
  const sandbox = config.syntheticMode;
  return (
    <div className={styles.page}>
      <div className="cv-container">
        <SiteHeader
          nav={<><Link href="/services">Help paths</Link><Link href="/">Open Civya</Link></>}
          right={<span className="cv-tag teal">{sandbox ? "Fictional preview" : "Controlled launch"}</span>}
        />
        <main id="main" className={styles.main}>
          <section className={styles.hero}>
            <p className={styles.eyebrow}>Safety and privacy</p>
            <h1>Easy to enter. Careful with what matters.</h1>
            <p className={styles.lede}>
              {sandbox
                ? "This fictional preview demonstrates how Civya separates account sign-in, County case access, and higher-risk actions. It is not connected to live Wayne County records or operations."
                : "Civya separates account sign-in, County case access, and every higher-risk action. Access and completion depend on authoritative County or approved-provider evidence—not on what a person or an AI says in a conversation."}
            </p>
          </section>

          <p className={styles.notice} role="note">
            {sandbox ? (
              <><strong>Preview only.</strong> Browser voice and private uploads can be demonstrated with configured sandbox services. Phone calls, real messages, production document scanning, payments, signing, and County staff follow-up are not live here.</>
            ) : (
              <><strong>Controlled launch.</strong> Availability is limited to the channels, workflows, staff, and providers explicitly approved for this deployment. Disabled or uncertain operations stay unavailable or pending.</>
            )}
          </p>

          <div className={styles.grid}>
            <article className={styles.card}>
              <h2>Signing in</h2>
              <p>Civya supports email, Google, Apple, LinkedIn, and passkeys. Only methods configured for this deployment are offered as available.</p>
              <p><strong>Signing in does not open Wayne County records.</strong></p>
            </article>
            <article className={styles.card}>
              <h2>Opening a case</h2>
              <p>A Wayne-approved case connection is separately required. Civya does not reveal possible addresses, balances, or case names while trying to match.</p>
            </article>
            <article className={styles.card}>
              <h2>Documents</h2>
              <p>Files start private and quarantined. A document must pass the configured safety checks and release policy before it can be used.</p>
            </article>
            <article className={styles.card}>
              <h2>Payments and signing</h2>
              <p>An approved handoff opens the official Wayne County, Chase, or DocuSign site. Civya does not collect card or bank credentials, and it waits for authoritative confirmation.</p>
            </article>
            <article className={styles.card}>
              <h2>Voice and phone</h2>
              <p>{config.features.pstn ? "Configured browser voice and phone service can continue approved help." : "Configured browser voice can continue approved help; phone service is currently unavailable."} Neither channel may choose a case, grant access, calculate an authoritative amount or deadline, or mark completion.</p>
            </article>
            <article className={styles.card}>
              <h2>When something is uncertain</h2>
              <p>The launch requirement is to say what remains safe, what did not complete, and what happens next. A real uncertain outcome must stay pending and receive a real staff owner.</p>
            </article>
          </div>

          <section className={styles.split}>
            <div className={styles.card}>
              <h2>Human help is a launch requirement</h2>
              <ul>
                <li>The service preserves context when staff help is requested from text, browser voice, or phone.</li>
                <li>A phone task may use a consented, single-use secure text link for safer web verification.</li>
                <li>Language or accessibility support must preserve the resident's place.</li>
              </ul>
              {sandbox && <p><strong>This preview does not request or guarantee real County follow-up.</strong></p>}
            </div>
            <div className={styles.card}>
              <h2>{sandbox ? "Explore the fictional demo" : "Start with Civya"}</h2>
              <p>{sandbox
                ? "Try general-information and sandbox conversation paths without treating any result as County advice, status, or completion."
                : "Start with a question or notice. Civya will clearly show when account sign-in, County case verification, an approved provider, or a person is required."}</p>
              <div className={styles.actions}>
                <Link className="cv-btn cv-btn-primary" href="/">Open Civya</Link>
                <Link className="cv-btn cv-btn-ghost" href="/services">See the help paths</Link>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
