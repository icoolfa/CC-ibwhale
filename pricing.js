/**
 * Model pricing data - ported from ccost (MIT License)
 * Source: https://github.com/toolsu/ccost/blob/main/src/pricing-data.json
 *
 * MIT License - ccost:
 * Copyright (c) 2025 ccost contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software.
 *
 * All prices are in USD per token.
 */

/**
 * @param {string} model - model name
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number } | null}
 */
function getPrice(model) {
  if (!model) return null;
  const m = model.toLowerCase();

  // Try exact match first, then prefix match
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (m === key || m.includes(key)) {
      return price;
    }
  }
  return null;
}

/**
 * Calculate cost for a given usage
 * @param {string} model
 * @param {object} usage - { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }
 * @returns {number} cost in USD
 */
function calcCost(model, usage) {
  const p = getPrice(model);
  if (!p) return 0;
  return (
    (usage.input_tokens || 0) * p.input +
    (usage.output_tokens || 0) * p.output +
    (usage.cache_read_tokens || 0) * p.cacheRead +
    (usage.cache_creation_tokens || 0) * p.cacheWrite
  );
}

const MODEL_PRICES = {
  "claude-opus-4-7":          { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  "claude-opus-4-6":          { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
  "claude-opus-4-5":          { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
  "claude-sonnet-4-6":        { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-sonnet-4-5":        { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-sonnet-4":          { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-3-7-sonnet":        { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-3-5-sonnet":        { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-3-sonnet":          { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-opus-4-1":          { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  "claude-opus-4":            { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  "claude-3-opus":            { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  "claude-haiku-4-5":         { input: 0.000001, output: 0.000005, cacheRead: 0.0000001, cacheWrite: 0.00000125 },
  "claude-3-5-haiku":         { input: 0.0000008, output: 0.000004, cacheRead: 0.00000008, cacheWrite: 0.000001 },
  "claude-3-haiku":           { input: 0.00000025, output: 0.00000125, cacheRead: 0.000000025, cacheWrite: 0.0000003125 },
  "claude-haiku":             { input: 0.0000008, output: 0.0000024, cacheRead: 0, cacheWrite: 0 },
  "claude-sonnet":            { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "claude-opus":              { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  "glm-5-code":               { input: 0.0000012, output: 0.000005, cacheRead: 0.0000003, cacheWrite: 0 },
  "glm-5":                    { input: 0.000001, output: 0.0000032, cacheRead: 0.0000002, cacheWrite: 0 },
  "glm-4.7":                  { input: 0.0000006, output: 0.0000022, cacheRead: 0.00000011, cacheWrite: 0 },
  "glm-4.6":                  { input: 0.0000006, output: 0.0000022, cacheRead: 0.00000011, cacheWrite: 0 },
  "glm-4.5":                  { input: 0.0000006, output: 0.0000022, cacheRead: 0, cacheWrite: 0 },
  "glm-4.5-x":                { input: 0.0000022, output: 0.0000089, cacheRead: 0, cacheWrite: 0 },
  "glm-4.5-airx":             { input: 0.0000011, output: 0.0000045, cacheRead: 0, cacheWrite: 0 },
  "glm-4.5-air":              { input: 0.0000002, output: 0.0000011, cacheRead: 0, cacheWrite: 0 },
  "glm-4.5v":                 { input: 0.0000006, output: 0.0000018, cacheRead: 0, cacheWrite: 0 },
  "glm-4.5-flash":            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "glm-4-32b":                { input: 0.0000001, output: 0.0000001, cacheRead: 0, cacheWrite: 0 },
  "kimi-k2.5":                { input: 0.0000006, output: 0.000003, cacheRead: 0.0000001, cacheWrite: 0 },
  "kimi-k2-thinking-turbo":   { input: 0.00000115, output: 0.000008, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-k2-turbo-preview":    { input: 0.00000115, output: 0.000008, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-k2-thinking":         { input: 0.0000006, output: 0.0000025, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-k2-0905-preview":     { input: 0.0000006, output: 0.0000025, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-k2-0711-preview":     { input: 0.0000006, output: 0.0000025, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-latest-128k":         { input: 0.000002, output: 0.000005, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-latest-32k":          { input: 0.000001, output: 0.000003, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-latest-8k":           { input: 0.0000002, output: 0.000002, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-latest":              { input: 0.000002, output: 0.000005, cacheRead: 0.00000015, cacheWrite: 0 },
  "kimi-thinking-preview":    { input: 0.0000006, output: 0.0000025, cacheRead: 0.00000015, cacheWrite: 0 },
  "minimax-m2.5-lightning":   { input: 0.0000003, output: 0.0000024, cacheRead: 0.00000003, cacheWrite: 0.000000375 },
  "minimax-m2.5":             { input: 0.0000003, output: 0.0000012, cacheRead: 0.00000003, cacheWrite: 0.000000375 },
  "minimax-m2.1-lightning":   { input: 0.0000003, output: 0.0000024, cacheRead: 0.00000003, cacheWrite: 0.000000375 },
  "minimax-m2.1":             { input: 0.0000003, output: 0.0000012, cacheRead: 0.00000003, cacheWrite: 0.000000375 },
  "minimax-m2":               { input: 0.0000003, output: 0.0000012, cacheRead: 0.00000003, cacheWrite: 0.000000375 },
  // Fallback defaults
  "opus":                     { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  "sonnet":                   { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  "haiku":                    { input: 0.0000008, output: 0.0000024, cacheRead: 0, cacheWrite: 0 },
  "gpt-4":                    { input: 0.000003, output: 0.000006, cacheRead: 0.00000075, cacheWrite: 0.00000375 },
  "gpt-3.5":                  { input: 0.0000005, output: 0.0000015, cacheRead: 0, cacheWrite: 0 },
  "qwen":                     { input: 0.0000004, output: 0.0000012, cacheRead: 0, cacheWrite: 0 },
  "deepseek-chat":            { input: 0.00000027, output: 0.0000011, cacheRead: 0, cacheWrite: 0 },
  "deepseek-reasoner":        { input: 0.00000055, output: 0.00000219, cacheRead: 0, cacheWrite: 0 },
  // Default fallback for unknown models
  "default":                  { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
};

module.exports = { getPrice, calcCost, MODEL_PRICES };
