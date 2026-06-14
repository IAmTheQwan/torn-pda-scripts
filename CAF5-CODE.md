# CAF5 Project Context

## Project

CAF5 (TheQwan Condensed Auction Filter 5)

A Torn PDA userscript providing:

* Auction filtering
* Watch lists
* Auction history/comps
* Quality tracking
* Global watch banner
* Premium licensing
* Supabase integration

## Development Goals

CAF5 should be designed as a commercial-quality Torn PDA application.

Goals:

1. Minimize Torn API usage.
2. Use Supabase as the primary backend.
3. Support free trial users.
4. Support monthly subscriptions.
5. Support lifetime licenses.
6. Support remote user activation/deactivation.
7. Support remote feature flags.
8. Support future modules without major rewrites.

## Licensing Model

User enters Torn API key once.

CAF5 sends only:

* Torn ID
* Name
* Level
* API verification data

to Supabase.

After registration:

* CAF5 should validate against Supabase.
* Torn API should not be queried repeatedly.
* License status should be cached locally.

License Types:

* Trial (3-4 days)
* Monthly (23.5M Torn cash)
* Lifetime (250M Torn cash)

## Architecture Rules

* Prefer modular code.
* Avoid global variables when practical.
* New features should be isolated into modules.
* Premium features should be controlled through a central license manager.
* All Supabase interactions should pass through a single service layer.

## Current Source

CAF5 began as a fork of CAF4.4.

CAF4 remains the stable branch.

CAF5 is the active development branch.

## Priority Roadmap

1. Repository setup
2. Settings panel
3. User registration
4. License manager
5. Trial system
6. Admin panel
7. Premium features
8. Marketplace enhancements

## Owner

TheQwan [3485263]
