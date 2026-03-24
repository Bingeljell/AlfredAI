# Experimental Lead Gen Plan

## Goal

Build an ICP-aware lead generation flow for Alfred that can help source outreach targets for an AI-first proposal maker.

Initial focus:

- USA-based MSPs
- USA-based systems integrators / IT consultancies
- Small to medium sized companies

Later expansion:

- Event planners
- Other service businesses with high proposal / quote / SOW volume

## Product Context

The product is an AI-first proposal maker. The best early customers are likely to be services businesses that:

- repeatedly create proposals, quotes, or scopes of work
- have small teams and imperfect process tooling
- are reachable through lightweight outbound

For MSPs and SIs, the best signals are often:

- service-heavy websites
- clear contact or sales paths
- recurring support / managed services messaging
- implementation, migration, cloud, security, network, or consulting keywords
- quote / estimate / consultation calls to action

## Pipeline Design

This should evolve into a staged pipeline, not one monolithic tool.

1. `lead_discover`
   Find candidate companies from search queries and directory-style discovery.

2. `lead_qualify`
   Determine whether the company matches the ICP:
   USA, small/medium, service business, likely to send proposals.

3. `lead_enrich_contacts`
   Pull generic business emails first, then named contacts where possible.

4. `lead_score`
   Score candidates by fit and proposal likelihood.

5. `lead_save`
   Persist canonical company records by normalized domain.

## First Implementation Slice

This experiment starts with a minimal but useful improvement to the current pipeline:

- normalize domains for better dedupe
- add profile-aware scoring for `msp`, `si`, and `event_planner`
- rank discovery candidates before extraction
- persist scored output to an experimental JSON ledger

The purpose is to improve lead quality before adding a full multi-stage tool stack.

## Scoring Signals

Positive signals:

- `managed services`, `it support`, `help desk`, `vcio`, `microsoft 365`, `azure`, `cybersecurity`
- `systems integrator`, `integration`, `implementation`, `consulting`, `automation`, `digital transformation`
- `request a quote`, `book a consultation`, `contact sales`, `proposal`, `statement of work`

Negative signals:

- directories, social sites, job boards, review sites
- large public sector / education domains
- obvious content farms, listicles, and vendor-only pages

## Validation Plan

Use the tool itself against a narrow query such as:

- `small managed service provider texas`
- `it consulting firm chicago microsoft partner`

Validation should inspect:

- domain dedupe quality
- candidate ranking quality
- whether the extracted leads feel like actual target accounts
- whether the saved ledger is reusable for follow-up outreach work
