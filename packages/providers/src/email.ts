/**
 * Transactional email. Templates are plain-text and contain no payment details beyond what the
 * recipient already owns. Providers:
 *  - SmtpEmailProvider: any SMTP relay (credentials from secret manager).
 *  - DevFileEmailProvider: demo/testnet ONLY — writes messages to a local directory so verification
 *    links can be followed during development. Refused on mainnet.
 *  - none: messages stay 'undeliverable' and the UI says email is not configured.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTransport, type Transporter } from "nodemailer";
import { DomainError, type Environment } from "@zeb/domain";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface EmailProvider {
  readonly name: string;
  send(m: EmailMessage): Promise<void>;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private t: Transporter;
  constructor(cfg: { url: string; from: string }) {
    if (!/^smtps?:\/\//.test(cfg.url)) throw new DomainError("SYSTEM_CONFIG", "SMTP_URL must be smtp:// or smtps://");
    this.t = createTransport(cfg.url, { from: cfg.from });
  }
  async send(m: EmailMessage) {
    await this.t.sendMail({ to: m.to, subject: m.subject, text: m.text });
  }
}

export class DevFileEmailProvider implements EmailProvider {
  readonly name = "dev-file";
  constructor(
    private dir: string,
    env: Environment,
  ) {
    if (env === "mainnet-enabled" || env === "mainnet-readonly") throw new DomainError("SYSTEM_CONFIG", "dev-file email is not permitted on mainnet");
    mkdirSync(dir, { recursive: true });
  }
  async send(m: EmailMessage) {
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${m.subject.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.txt`;
    writeFileSync(join(this.dir, name), `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`, { mode: 0o600 });
  }
}

export const TEMPLATES = {
  verify_email: (p: { link: string }) => ({
    subject: "Verify your Zeb Scan email",
    text: `Confirm your email address to finish setting up Zeb Scan:\n\n${p.link}\n\nThis link expires in 24 hours. If you did not sign up, ignore this message.`,
  }),
  reset_password: (p: { link: string }) => ({
    subject: "Reset your Zeb Scan password",
    text: `A password reset was requested for this address.\n\n${p.link}\n\nThis link expires in 30 minutes and works once. If you did not request it, you can ignore this email; your password is unchanged.`,
  }),
  login_otp: (p: { code: string }) => ({
    subject: "Your Zeb Scan sign-in code",
    text: `Your one-time sign-in code is ${p.code}. It expires in 10 minutes and works once. If you did not request it, ignore this email.`,
  }),
  security_notice: (p: { what: string }) => ({
    subject: "Zeb Scan security notice",
    text: `This is a notice that the following change was made to your Zeb Scan account:\n\n${p.what}\n\nIf this was not you, sign in, revoke your sessions and contact support immediately.`,
  }),
} as const;
export type TemplateName = keyof typeof TEMPLATES;
