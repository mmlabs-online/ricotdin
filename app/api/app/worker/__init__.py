"""Pipeline worker (ARC-08): a separate process (``python -m app.worker``) that claims ``jobs``
rows with ``claim_next_job`` (``FOR UPDATE SKIP LOCKED``) and runs them step by step as
``ricotdin_worker``. See CLAUDE.md §0.7."""
