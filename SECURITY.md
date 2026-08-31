# Security policy

## Supported versions

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting feature for this repository. Do not include credentials, tokens, private entity inventories, account identifiers, addresses, or unredacted Home Assistant logs in a public issue.

This frontend card can only call services permitted to the signed-in Home Assistant user. The backend integration remains responsible for authorization, concurrency, duration enforcement, timers, safe stopping, and confirmation of controller state. The card is not a substitute for backend safety checks.
