# Usage analytics design

## Goal

Give the GestureDeck owner a clear view of public-site traffic and whether visitors use the core presentation flow, while keeping presentation files and content in the browser.

## Current project context

GestureDeck is a vanilla JavaScript site deployed to Vercel. It has no user accounts. The Vercel deployment can use Upstash Redis for hosted phone relay state; the local development server and local phone relay are separate. PDF files are opened and rendered in the browser. The current README says presentation files and content remain local.

Vercel Web Analytics provides page views, visitors, referrers, and trends on Hobby. Custom event tracking is limited to Pro and Enterprise. Vercel’s Web Analytics API can query the same aggregate data as its dashboard, but does not remove the custom-event plan limit. References: [Web Analytics](https://vercel.com/docs/analytics), [pricing and limits](https://vercel.com/docs/analytics/limits-and-pricing), and [Web Analytics API announcement](https://vercel.com/changelog/web-analytics-api).

## Approaches considered

1. **Vercel Web Analytics only.** Lowest effort and covers public traffic, but Hobby does not provide custom events for the PDF/phone funnel or presentation duration.
2. **Split sources (selected).** Use Vercel Web Analytics for traffic, and a small first-party collector with Redis-backed aggregates for feature use. Show traffic in the Vercel dashboard and feature use on a password-protected GestureDeck page. This works without upgrading the Vercel plan, at the cost of using two sources.
3. **Vercel Pro or Enterprise.** Track all traffic and custom events in Vercel, then query the same aggregate data for an in-app page. This is the cleanest single source, but depends on a paid plan.

## Approved design

### Traffic analytics

Enable Vercel Web Analytics for the production deployment. Use its dashboard for anonymous visitors, page views, referrers, and traffic trends. Do not count the private analytics page or its login flow as public traffic. The in-app analytics page does not duplicate traffic data in the Hobby-compatible design.

### Feature events and metrics

Add a same-origin Vercel function that accepts a strict allowlist of event types and updates a separate analytics namespace in the existing Upstash Redis. The collector stores only daily aggregates and short-lived session state needed to deduplicate events and calculate the funnel.

Track these hosted-production events:

- A PDF import succeeds after the first page has rendered.
- A phone joins a hosted presentation session.
- A presentation session uses both a successfully imported PDF and a connected phone.
- At least one phone navigation command is used in a session.
- Presentation duration, measured from the first phone connection until the hosted session ends, with a maximum of four hours.

Use a random, short-lived session key to associate events within a browser session and count each funnel step once. Keep that state for at most 24 hours. Retain daily aggregate counts for 90 days and expose 7-, 30-, and 90-day summaries on the private page. Abruptly closed sessions may not report a final duration; reported durations are engagement estimates, not precise active time.

Do not send or store PDF names, bytes, page contents, slide positions, phone labels, account identifiers, or persistent user identifiers. Vercel Web Analytics and the feature collector remain separate sources, so their numbers are not expected to match exactly. Counts describe use of the hosted public site only; local development and self-hosted copies are not included.

### Private page and access

Add an `/analytics` page for feature-use summaries. Protect both the page data and its API with one owner password configured as a Vercel environment secret. Keep password and Redis credentials server-side; issue a time-limited, secure, HTTP-only, same-site session cookie after a successful login. Do not add user accounts.

### Reliability and privacy disclosure

The event collector is best-effort and must never block PDF import, phone pairing, or presenting. If Redis or its configuration is unavailable, event writes are dropped and the dashboard reports that its data is unavailable. Validate request origin, body size, and event names before updating counters.

Update public privacy copy and the README to disclose anonymous traffic and usage measurements. Keep the statement that uploaded PDFs and presentation content stay in the browser.

## Verification

Add focused Node.js tests for event validation, per-session deduplication, aggregate summaries and retention, dashboard password protection, and collector/dashboard behavior when Redis is unavailable. Update privacy/setup documentation and the Vercel asset/configuration allowlists as needed. Run the focused tests, `npm run check`, `npm run lint`, and `npm test` because this change crosses the static site, API routes, Redis storage, and privacy documentation.

## Acceptance criteria

- Vercel shows production visitors, page views, referrers, and traffic trends.
- The private page shows daily PDF imports, phone-connected sessions, sessions using both, phone-navigation sessions, and presentation-duration summaries for 7/30/90 days.
- An unauthenticated request cannot read usage summaries.
- Analytics failures do not affect presentation behavior.
- Analytics payloads contain no document content or persistent user identity, and temporary session state expires within 24 hours.
- Public privacy copy accurately discloses analytics while preserving the local-PDF privacy promise.
