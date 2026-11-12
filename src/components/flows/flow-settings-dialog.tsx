"use client";

import { useState } from "react";
import { Bot, Clock, HelpCircle, MessageSquare, Sparkles, UserCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFlowEditor } from "./flow-editor-state";
import type { FlowFallbackPolicy, FlowFollowupConfig } from "@/lib/flows/types";

interface FlowSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FlowSettingsDialog({
  open,
  onOpenChange,
}: FlowSettingsDialogProps) {
  const { state, setState } = useFlowEditor();
  const policy: FlowFallbackPolicy = state.fallback_policy;

  const updatePolicy = (patch: Partial<FlowFallbackPolicy>) => {
    setState((prev) => ({
      ...prev,
      fallback_policy: {
        ...prev.fallback_policy,
        ...patch,
      },
    }));
  };

  const followups: FlowFollowupConfig[] =
    policy.followups && policy.followups.length > 0
      ? policy.followups
      : [
          {
            delay_hours: 2,
            message:
              "Hi {{contact.name}}, just following up to see if you had any questions about the options above?",
          },
          {
            delay_hours: 24,
            message:
              "Let us know if you'd still like help with this, or feel free to message us whenever you're ready!",
          },
        ];

  const updateFollowup = (index: number, patch: Partial<FlowFollowupConfig>) => {
    const next = [...followups];
    next[index] = { ...next[index], ...patch };
    updatePolicy({ followups: next });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Behavior & Inactivity Settings
          </DialogTitle>
          <DialogDescription>
            Configure how this flow handles off-script customer questions and automated no-reply follow-ups.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="ai-fallback" className="w-full mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="ai-fallback" className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              AI Fallback (Off-Script)
            </TabsTrigger>
            <TabsTrigger value="followups" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              No-Answer Follow-ups
            </TabsTrigger>
          </TabsList>

          {/* ================= AI FALLBACK TAB ================= */}
          <TabsContent value="ai-fallback" className="space-y-4 pt-3">
            <div className="space-y-2">
              <Label className="text-sm font-semibold">
                When customer sends an off-script question or unrecognized text
              </Label>
              <Select
                value={policy.on_unknown_reply}
                onValueChange={(val) => val && updatePolicy({ on_unknown_reply: val as any })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ai_fallback">
                    🤖 Answer with AI & guide back to flow (Recommended)
                  </SelectItem>
                  <SelectItem value="reprompt">
                    🔁 Re-prompt the same options / buttons
                  </SelectItem>
                  <SelectItem value="handoff">
                    👤 Escalate to human agent immediately
                  </SelectItem>
                  <SelectItem value="ignore">
                    ⏭️ Ignore off-script message
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {policy.on_unknown_reply === "ai_fallback" &&
                  "The AI uses your Knowledge Base to answer the customer's question directly, then invites them back to choose an option."}
                {policy.on_unknown_reply === "reprompt" &&
                  "Repeats the previous button or list options without AI answering."}
                {policy.on_unknown_reply === "handoff" &&
                  "Pauses the flow and routes the conversation to a human agent's pending queue."}
              </p>
            </div>

            {policy.on_unknown_reply === "ai_fallback" && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">Re-send buttons after AI answer</Label>
                    <p className="text-xs text-muted-foreground">
                      Presents the interactive buttons again after the AI reply so the customer can tap immediately.
                    </p>
                  </div>
                  <Switch
                    checked={policy.ai_fallback_resend_prompt !== false}
                    onCheckedChange={(checked) =>
                      updatePolicy({ ai_fallback_resend_prompt: checked })
                    }
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold">
                      Max AI Answers Before Human Escalation
                    </Label>
                    <Select
                      value={String(policy.max_reprompts ?? 2)}
                      onValueChange={(val) =>
                        val && updatePolicy({ max_reprompts: parseInt(val, 10) })
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 AI answer, then escalate</SelectItem>
                        <SelectItem value="2">2 AI answers, then escalate</SelectItem>
                        <SelectItem value="3">3 AI answers, then escalate</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold">After Max AI Turns</Label>
                    <Select
                      value={policy.on_exhaust ?? "handoff"}
                      onValueChange={(val) => val && updatePolicy({ on_exhaust: val as any })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="handoff">Hand off to Human Agent</SelectItem>
                        <SelectItem value="end">Complete / End Flow</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">
                    Custom AI Instructions for Flow Fallback (Optional)
                  </Label>
                  <Textarea
                    placeholder="e.g. Keep answers warm, friendly, and concise (1-2 sentences). Always remind the customer we offer free video consultations."
                    value={policy.ai_fallback_prompt ?? ""}
                    onChange={(e) => updatePolicy({ ai_fallback_prompt: e.target.value })}
                    rows={3}
                    className="text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Overrides or supplements the global AI assistant instructions specifically when replying inside this flow.
                  </p>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ================= FOLLOW-UPS TAB ================= */}
          <TabsContent value="followups" className="space-y-4 pt-3">
            <div className="flex items-center justify-between rounded-lg border border-border p-3.5 bg-card">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-semibold">Enable Inactivity Follow-ups</Label>
                  <span className="text-[10px] bg-primary/10 text-primary font-medium px-1.5 py-0.5 rounded">
                    Auto-Nudge
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Automatically send 1 to 2 reminder messages if the customer goes quiet without completing the flow.
                </p>
              </div>
              <Switch
                checked={Boolean(policy.followup_enabled)}
                onCheckedChange={(checked) => updatePolicy({ followup_enabled: checked })}
              />
            </div>

            {policy.followup_enabled && (
              <div className="space-y-4">
                {/* Follow-up 1 */}
                <div className="rounded-lg border border-border p-3.5 space-y-2.5 bg-card">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold flex items-center gap-1.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                        1
                      </span>
                      First Follow-up Reminder
                    </Label>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span>Send after</span>
                      <Input
                        type="number"
                        min={1}
                        max={72}
                        value={followups[0]?.delay_hours ?? 2}
                        onChange={(e) =>
                          updateFollowup(0, {
                            delay_hours: parseInt(e.target.value || "2", 10),
                          })
                        }
                        className="h-7 w-16 text-center text-xs"
                      />
                      <span>hours</span>
                    </div>
                  </div>
                  <Textarea
                    placeholder="Enter first reminder message..."
                    value={followups[0]?.message ?? ""}
                    onChange={(e) => updateFollowup(0, { message: e.target.value })}
                    rows={2}
                    className="text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Supports variables like <code className="text-primary">{"{{contact.name}}"}</code> and <code className="text-primary">{"{{vars.xyz}}"}</code>.
                  </p>
                </div>

                {/* Follow-up 2 */}
                <div className="rounded-lg border border-border p-3.5 space-y-2.5 bg-card">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold flex items-center gap-1.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                        2
                      </span>
                      Second Follow-up (Final Nudge)
                    </Label>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span>Send after</span>
                      <Input
                        type="number"
                        min={2}
                        max={168}
                        value={followups[1]?.delay_hours ?? 24}
                        onChange={(e) =>
                          updateFollowup(1, {
                            delay_hours: parseInt(e.target.value || "24", 10),
                          })
                        }
                        className="h-7 w-16 text-center text-xs"
                      />
                      <span>hours</span>
                    </div>
                  </div>
                  <Textarea
                    placeholder="Enter second reminder message..."
                    value={followups[1]?.message ?? ""}
                    onChange={(e) => updateFollowup(1, { message: e.target.value })}
                    rows={2}
                    className="text-xs"
                  />
                </div>

                {/* Final action */}
                <div className="grid grid-cols-2 gap-4 rounded-lg border border-muted p-3 bg-muted/20">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Final Stale Timeout</Label>
                    <div className="flex items-center gap-1 text-xs">
                      <Input
                        type="number"
                        min={12}
                        max={168}
                        value={policy.on_timeout_hours ?? 48}
                        onChange={(e) =>
                          updatePolicy({
                            on_timeout_hours: parseInt(e.target.value || "48", 10),
                          })
                        }
                        className="h-7 w-20 text-center text-xs"
                      />
                      <span>hours total</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium">If Still No Answer</Label>
                    <Select
                      value={policy.on_exhaust ?? "handoff"}
                      onValueChange={(val) => val && updatePolicy({ on_exhaust: val as any })}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="handoff">Hand off to Agent Inbox</SelectItem>
                        <SelectItem value="end">Complete / Close Flow</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
