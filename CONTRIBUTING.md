# Contributing

Thank you for helping improve Sprinkler Sequence Card.

1. Open an issue describing the backend contract or UI behavior you want to change.
2. Create a focused branch and preserve the fail-closed runtime-state contract.
3. Add or update synthetic tests for every service mapping or lifecycle change.
4. Run `npm run validate` before opening a pull request.

Pull requests must not add browser-owned sprinkler timers, multi-call client sequences, guessed controller states, private entity IDs, network addresses, account identifiers, or credentials. New adapters should document the backend service schema and demonstrate that one accepted click produces exactly one service call.

Do not use physical watering as an automated test. Tests and continuous integration must remain synthetic.
