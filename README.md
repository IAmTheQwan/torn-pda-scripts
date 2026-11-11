# torn-pda-scripts
Torn PDA scripts by TheQwan

Bookie development: edit `qwantum-bookie.source.js`, then run `./build-bookie.ps1` to generate the compact PDA install file.

Compliance checks: run `node test-compliance.js`. The auction filter must only process the actively viewed Torn page and must not batch-request Torn page endpoints. Bookie Torn API features share a conservative rolling request ledger below Torn's per-user limit.
