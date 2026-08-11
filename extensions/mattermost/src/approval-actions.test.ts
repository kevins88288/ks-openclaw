// Mattermost tests cover the transport-private approval callback envelope.
import { describe, expect, it } from "vitest";
import {
  decodeMattermostApprovalAction,
  encodeMattermostApprovalAction,
} from "./approval-actions.js";

describe("Mattermost approval actions", () => {
  it("round-trips explicit approval facts without slash-command inference", () => {
    const action = {
      type: "approval" as const,
      approvalId: "plugin:req/50%/😀",
      approvalKind: "plugin" as const,
      decision: "allow-always" as const,
    };

    const encoded = encodeMattermostApprovalAction(action);

    expect(encoded).not.toContain("/approve ");
    expect(decodeMattermostApprovalAction(encoded)).toEqual(action);
  });

  it.each(["exec", "plugin"] as const)("round-trips every approvalKind (%s)", (approvalKind) => {
    const action = {
      type: "approval" as const,
      approvalId: "req-1",
      approvalKind,
      decision: "deny" as const,
    };
    expect(decodeMattermostApprovalAction(encodeMattermostApprovalAction(action))).toEqual(action);
  });

  it.each([
    [undefined, "non-string input"],
    [42, "number input"],
    [["openclaw:approval:v1:{}"], "array input"],
    ["openclaw:approval:v2:{}", "wrong prefix"],
    ["openclaw:approval:v1:not-json", "tampered JSON"],
    ['openclaw:approval:v1:{"approvalId":"req-1","decision":"allow-once"}', "missing approvalKind"],
    [
      'openclaw:approval:v1:{"approvalId":"req-1","approvalKind":"exec","decision":"accept"}',
      "bad decision",
    ],
    [
      'openclaw:approval:v1:{"approvalId":"req-1","approvalKind":"widget","decision":"deny"}',
      "bad approvalKind",
    ],
    [
      'openclaw:approval:v1:{"approvalId":"","approvalKind":"exec","decision":"deny"}',
      "empty approvalId",
    ],
    [
      'openclaw:approval:v1:{"approvalId":"req-1","approvalKind":"exec","decision":"deny","extra":true}',
      "extra key",
    ],
    ['openclaw:approval:v1:["req-1","exec","deny"]', "JSON array payload"],
  ])("fails closed on %s (%s)", (value) => {
    expect(decodeMattermostApprovalAction(value)).toBeNull();
  });
});
