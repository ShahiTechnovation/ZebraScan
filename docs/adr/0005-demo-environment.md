# ADR-0005 — A `demo` environment in the backend
Status: accepted

To exercise the full browser → API → DB → worker path without a chain, the backend supports `ZEB_ENVIRONMENT=demo`: non-payable placeholder addresses (`zebscan-demo-address-…-not-payable`), fictional rates, a simulated 25,000 USDC inventory and a simulated LP. Every DEMO implementation throws if constructed in any other environment, every response carries `label: "DEMO"`, and demo-only routes are not registered elsewhere.
