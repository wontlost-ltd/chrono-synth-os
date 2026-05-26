# Press Kit — ChronoSynth

**Last updated**：2026-05-26
**Public URL**：`chronosynth.com/press` (mirror of this file on Framer)

For press inquiries, demo videos, or to schedule an interview:
**ryan@wontlost.com**

---

## At a Glance

- **Product**：ChronoSynth — Governance layer for production AI agents
- **Audience**：50–500 person companies running LangChain / CrewAI / OpenAI Agents SDK in production
- **Pricing**：Free (3 agents) · Team $399/mo · Enterprise $2,500+/mo
- **Founded**：2024
- **HQ**：Singapore
- **Founder**：Ryan Pang
- **Open-source**：Yes — kernel under MIT (`@chrono/kernel`)
- **Repo**：[github.com/wontlost-ltd/chrono-synth-os](https://github.com/wontlost-ltd/chrono-synth-os)
- **Website**：[chronosynth.com](https://chronosynth.com)

---

## Boilerplate (100 words)

ChronoSynth is the governance layer that mid-market companies use to ship
production AI agents without breaking compliance. While observability tools
like LangSmith and Helicone watch *what the LLM says*, ChronoSynth watches
*what the agent does* — per-tool permissions, immutable audit logs anchored
to a KMS-backed evidence chain, and behavioral drift detection against signed
baselines. The kernel is open-source (MIT) and the hosted Enterprise tier
provides BYOK KMS, SCIM, and 7-year audit retention. Built for the
five-engineer fintech / health / legal teams quietly running LangChain in
production who know they need governance before compliance comes asking.

---

## Founder Bio (30 words)

**Ryan Pang** — founder of ChronoSynth. Previously built systems for
identity governance and audit at financial-services firms. Lives in
Singapore.

---

## Logo & Wordmark Downloads

| Asset | Format | Use |
|---|---|---|
| [wordmark.svg](../assets/brand/wordmark.svg) | SVG | Light backgrounds |
| [wordmark-dark.svg](../assets/brand/wordmark-dark.svg) | SVG | Dark backgrounds |
| [favicon.svg](../assets/brand/favicon.svg) | SVG | Icon only |
| [favicon.png](../assets/brand/favicon.png) | PNG (512×512) | Icon only, raster |
| [og-image.svg](../assets/brand/og-image.svg) | SVG | Social share, vector |
| [og-image.png](../assets/brand/og-image.png) | PNG (1200×630) | Social share, raster |

**Color palette**：
- Primary blue：`#1E3A8A`
- Accent purple：`#7C3AED`
- Accent gold：`#FBBF24`
- Background dark：`#0F172A`

**Typography**：Inter (system-ui fallback)

---

## Product Screenshots

| Screenshot | Description |
|---|---|
| [01-admin-tools.png](../assets/screenshots/01-admin-tools.png) | Tool permissions registry, per-agent + per-scope |
| [02-audit-detail.png](../assets/screenshots/02-audit-detail.png) | Audit log detail drawer with policy + outcome |
| [03-drift.png](../assets/screenshots/03-drift.png) | Behavioral drift detection dashboard |

> Note: screenshots above use the `acme-corp` seed data — no real customer data.

---

## Demo Video

**90-second demo**：[Loom link TBD — embedded on landing page]
**Full walkthrough**（15 min）：available on request

---

## Coverage

- _(Empty for now — fill in as press picks up)_

---

## Key Quotes (approved for use)

> "Observability tells you what your LLM said. Governance tells you what
> your agent *did* — and gives you the audit trail to prove it."
> — Ryan Pang, Founder

> "If five LangChain agents in production keep you up at night, that's
> the gap we filled."
> — Ryan Pang, Founder

---

## FAQ for Press

**Q: How is this different from LangSmith?**
A: LangSmith watches LLM API calls (prompt → completion). ChronoSynth
watches tool invocations (the agent actually doing things in the world).
Different layer of the stack — they complement, don't compete.

**Q: Who's using it?**
A: Three design partners — a Series B fintech, a 200-person legal-tech
company, and a regulated health-data consultancy — currently running
production agents on ChronoSynth. Combined audited invocations and
specific case studies available under NDA.

**Q: Is it really open-source?**
A: Yes. The kernel (`@chrono/kernel`) is MIT-licensed and lives in
the public repo. The hosted control plane (auth, billing, multi-tenant
isolation, BYOK KMS) is closed. Same model as GitLab CE/EE.

**Q: When can I install it?**
A: Today. Self-hosted via Helm chart (`chrono-synth-deploy`) or signed
Docker images on GHCR. Hosted SaaS at chronosynth.com.

---

## Contact

**Press**：ryan@wontlost.com
**Engineering**：see GitHub issues
**Security disclosures**：security@chronosynth.com (PGP key on website)
