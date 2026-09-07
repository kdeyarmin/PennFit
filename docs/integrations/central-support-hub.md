# Central CareMetric Support Hub

CareMetric Breathe can route its authenticated **admin software-support**
entry to the first-party centralized Support Hub:

`https://support-hub-web-production.up.railway.app/help`

This integration is deliberately separate from patient and DME service. It
does not change the public `/help` page, `FloatingContactLauncher`, mobile
"Talk to us" action, or tenant-specific phone/email routing.

## Rollout and rollback

Set this browser build variable on the production `resupply-api` Railway
service, which builds and embeds the `cpap-fitter` SPA, and redeploy:

```dotenv
VITE_CENTRAL_SUPPORT_HUB_ENABLED=true
```

The flag is positive opt-in: only the exact string `true` enables the Hub.
Missing, empty, malformed, and `false` values retain the existing local
`/admin/support` ticket page. Set the value to `false` and redeploy to roll
back without a code or database change.

Railway's `RAILWAY_GIT_COMMIT_SHA` and `RAILWAY_ENVIRONMENT_NAME` become the
non-sensitive app version and environment diagnostics automatically. Other
deployment systems can override them with:

```dotenv
VITE_APP_VERSION=v1.2.3
VITE_APP_ENVIRONMENT=production
```

## Outbound URL contract

The launcher has a closed query schema:

| Parameter     | Source                              | Safety rule                                             |
| ------------- | ----------------------------------- | ------------------------------------------------------- |
| `product`     | Constant `breathe`                  | Never derived from tenant or user data                  |
| `route`       | Active compile-time admin nav href  | Optional; never a raw browser pathname                  |
| `app_version` | Release value or Railway commit SHA | Restricted to release-safe characters and 48 characters |
| `environment` | Explicit/Railway environment        | Normalized to `production`, `staging`, or `development` |

Before selecting route context, the client removes query/hash content and
rejects malformed, encoded, absolute, API, public, and unknown locations.
Parameterized detail routes collapse to their static navigation destination;
for example, `/admin/patients/<id>` becomes `/admin/patients`. When no static
nav destination matches, the Hub opens without a `route` parameter.

The launcher API accepts no user ID, email, organization/tenant ID, patient
identifier, ticket text, search terms, or arbitrary query fields. These values
must never be added to the outbound URL.

## Central software-support contacts

- Phone: [(877) 521-2890](tel:+18775212890)
- Email: [support@caremetric.ai](mailto:support@caremetric.ai)

These are platform software-support contacts. Patient/DME contacts continue to
come from the active tenant configuration on the existing public help surface.

