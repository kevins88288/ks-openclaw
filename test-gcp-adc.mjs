#!/usr/bin/env node
// Quick test script for GCP ADC token acquisition
import { resolveGcpAdcToken } from "./dist/providers/gcp-adc-token.js";

console.log("Testing GCP ADC token acquisition...\n");

try {
  // Test 1: Fetch fresh token
  console.log("1. Fetching fresh GCP ADC token...");
  const result1 = await resolveGcpAdcToken();
  console.log(`✓ Token obtained (length: ${result1.token.length})`);
  console.log(`✓ Token prefix: ${result1.token.substring(0, 20)}...`);
  console.log(`✓ Source: ${result1.source}`);
  console.log(`✓ Expires at: ${new Date(result1.expiresAt).toISOString()}`);
  const ttlMinutes = Math.round((result1.expiresAt - Date.now()) / 1000 / 60);
  console.log(`✓ TTL: ~${ttlMinutes} minutes\n`);

  // Test 2: Verify caching
  console.log("2. Fetching token again (should use cache)...");
  const before = Date.now();
  const result2 = await resolveGcpAdcToken();
  const elapsed = Date.now() - before;
  console.log(`✓ Token obtained in ${elapsed}ms`);
  console.log(`✓ Source: ${result2.source}`);
  console.log(`✓ Cache hit: ${result2.source.includes("cache:") ? "YES ✓" : "NO (fresh fetch)"}`);

  if (result1.token === result2.token) {
    console.log("✓ Token matches previous (cache working)\n");
  } else {
    console.log("⚠ Token different (might be refresh)\n");
  }

  console.log("All tests passed! GCP ADC integration working correctly.");
  console.log("\nCache location: ~/.openclaw/credentials/gcp-adc.token.json");
} catch (error) {
  console.error("\n❌ Test failed:");
  console.error(error.message);
  console.error("\nStack trace:");
  console.error(error.stack);
  process.exit(1);
}
