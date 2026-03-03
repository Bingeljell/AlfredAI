# To Revisit

- Make sub-ReAct browsing budget user-configurable from product-level config (max pages, browse concurrency, extraction batch size).
- Raise `ALFRED_SUBREACT_LLM_MAX_CALLS` from testing cap `6` to `12` or `15` after extraction quality validation is stable.
- Evaluate promoting sub-ReAct to a full top-level open-ended ReAct orchestration loop across all tools.
- Add robots-aware scraping mode for production profile while keeping dev profile flexible.
