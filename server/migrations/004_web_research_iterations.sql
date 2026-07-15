-- Migration: Create web_research_iterations table for server-side web research checkpointing
-- Replaces the fragile client-side in-memory iteration loop for external_risk_overlay
-- and social_reputation modules.

CREATE TABLE IF NOT EXISTS web_research_iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL,
  run_id UUID NOT NULL,
  module_id TEXT NOT NULL,
  iteration INT NOT NULL,
  query TEXT,
  finding TEXT,
  confidence INT,
  platform TEXT,
  category TEXT,
  sources JSONB,
  materiality TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, iteration)
);

-- Index for loading iterations by run (resume path)
CREATE INDEX IF NOT EXISTS idx_web_research_iterations_run
  ON web_research_iterations (run_id, iteration);

-- Index for deal-level queries (diagnostics)
CREATE INDEX IF NOT EXISTS idx_web_research_iterations_deal
  ON web_research_iterations (deal_id, module_id);
