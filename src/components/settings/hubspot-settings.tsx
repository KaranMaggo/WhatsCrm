'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  Zap,
  RotateCcw,
  Sparkles,
  RefreshCw,
  Trash2,
  Send,
  Activity,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SettingsPanelHead } from './settings-panel-head';
import { useAuth } from '@/hooks/use-auth';

interface SyncLogItem {
  id: string;
  account_id: string;
  contact_id?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  action: 'created' | 'updated' | 'failed';
  hubspot_contact_id?: string | null;
  status: 'success' | 'error';
  error_message?: string | null;
  source: string;
  created_at: string;
}

export function HubSpotSettings() {
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [hasToken, setHasToken] = useState(false);
  const [isEnv, setIsEnv] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const [portalId, setPortalId] = useState('');
  const [autoSyncOnMessage, setAutoSyncOnMessage] = useState(true);
  const [autoSyncContacts, setAutoSyncContacts] = useState(true);

  const [connected, setConnected] = useState<boolean | null>(null);
  const [statusMessage, setStatusMessage] = useState('');

  // Logs state
  const [logs, setLogs] = useState<SyncLogItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);

  // Quick Test Sync form
  const [showTestSync, setShowTestSync] = useState(false);
  const [testEmail, setTestEmail] = useState('demo.lead@example.com');
  const [testName, setTestName] = useState('Demo Lead');
  const [testPhone, setTestPhone] = useState('+15551234567');
  const [runningTestSync, setRunningTestSync] = useState(false);

  useEffect(() => {
    fetchConfig();
    fetchLogs();
  }, []);

  async function fetchConfig() {
    setLoading(true);
    try {
      const res = await fetch('/api/integrations/hubspot/config');
      if (res.ok) {
        const data = await res.json();
        setHasToken(data.has_token);
        setIsEnv(data.is_env);
        setPortalId(data.portal_id || '');
        setAutoSyncOnMessage(data.auto_sync_on_message !== false);
        setAutoSyncContacts(data.auto_sync_contacts !== false);
        setConnected(data.configured ? true : false);
        if (data.configured) {
          setStatusMessage(data.is_env ? 'Configured via environment variable' : 'Connected to HubSpot');
        } else {
          setStatusMessage('Not connected');
        }
      }
    } catch (err) {
      console.error('Failed to load HubSpot config:', err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchLogs() {
    setLoadingLogs(true);
    try {
      const res = await fetch('/api/integrations/hubspot/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Failed to load HubSpot sync logs:', err);
    } finally {
      setLoadingLogs(false);
    }
  }

  async function handleClearLogs() {
    setClearingLogs(true);
    try {
      const res = await fetch('/api/integrations/hubspot/logs', { method: 'DELETE' });
      if (res.ok) {
        setLogs([]);
        toast.success('Sync logs cleared.');
      }
    } catch (err) {
      toast.error('Failed to clear logs.');
    } finally {
      setClearingLogs(false);
    }
  }

  async function handleTest(testToken?: string) {
    setTesting(true);
    const tokenToTest = (testToken || accessToken || '').trim();
    try {
      const res = await fetch('/api/integrations/hubspot/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: tokenToTest || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        setConnected(true);
        setStatusMessage('Connected to HubSpot');
        toast.success('Successfully connected to HubSpot CRM!');

        // If a new token was tested and user has admin permissions, auto-save to database immediately
        if (tokenToTest && canEditSettings) {
          try {
            await fetch('/api/integrations/hubspot/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                access_token: tokenToTest,
                portal_id: portalId,
                auto_sync_on_message: autoSyncOnMessage,
                auto_sync_contacts: autoSyncContacts,
              }),
            });
            fetchConfig();
          } catch {
            // Non-critical, user can still click Save Settings
          }
        }
      } else {
        setConnected(false);
        setStatusMessage(data.error || 'Connection failed');
        toast.error(data.error || 'Failed to connect to HubSpot');
      }
    } catch (err) {
      setConnected(false);
      const msg = err instanceof Error ? err.message : 'Connection test failed';
      setStatusMessage(msg);
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canEditSettings) {
      toast.error('Only administrators can update integration settings.');
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        portal_id: portalId,
        auto_sync_on_message: autoSyncOnMessage,
        auto_sync_contacts: autoSyncContacts,
      };

      if (accessToken.trim()) {
        payload.access_token = accessToken.trim();
      }

      const res = await fetch('/api/integrations/hubspot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save settings');
      }

      toast.success('HubSpot settings saved successfully.');
      setAccessToken('');
      fetchConfig();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save HubSpot settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleRunTestSync(e: React.FormEvent) {
    e.preventDefault();
    if (!testEmail && !testPhone) {
      toast.error('Please provide an email or phone number.');
      return;
    }

    setRunningTestSync(true);
    try {
      const res = await fetch('/api/integrations/hubspot/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: testEmail.trim() || undefined,
          name: testName.trim() || undefined,
          phone: testPhone.trim() || undefined,
          source: 'test',
          access_token: accessToken.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to sync test contact');
      }

      const actionText = data.action === 'created' ? 'Created new contact' : 'Updated existing contact';
      toast.success(`HubSpot Sync Success: ${actionText} (#${data.hubspotContactId})`);
      fetchLogs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test sync failed');
      fetchLogs();
    } finally {
      setRunningTestSync(false);
    }
  }

  function formatSource(source: string) {
    switch (source) {
      case 'whatsapp_message':
        return 'WhatsApp Message';
      case 'manual':
        return 'Manual Click';
      case 'contact_form':
        return 'Contact Form';
      case 'test':
        return 'Test Sync';
      case 'api':
        return 'API';
      default:
        return source;
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title="HubSpot Integration"
        description="Sync contacts between WhatsCRM and HubSpot automatically when WhatsApp messages are received or contacts are updated."
      />

      {/* Connection Status Card */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500 font-bold text-lg">
                HS
              </div>
              <div>
                <CardTitle className="text-base font-semibold">HubSpot Connection</CardTitle>
                <CardDescription className="text-xs">
                  {statusMessage || (connected ? 'Connected' : 'Not configured')}
                </CardDescription>
              </div>
            </div>
            {connected ? (
              <Badge variant="outline" className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <XCircle className="size-3.5" />
                Disconnected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hubspot-token" className="text-sm font-medium">
                Private App Access Token
              </Label>
              <div className="relative flex items-center">
                <Input
                  id="hubspot-token"
                  type={showToken ? 'text' : 'password'}
                  placeholder={hasToken ? '••••••••••••••••••••••••••••••••' : 'pat-na1-...'}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  disabled={!canEditSettings}
                  className="pr-20 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-3 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {isEnv ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    Loaded from HUBSPOT_ACCESS_TOKEN environment variable. You can override it here.
                  </span>
                ) : hasToken ? (
                  'A private app access token is already configured. Enter a new token only to replace it.'
                ) : (
                  'Create a Private App in your HubSpot account under Settings → Integrations → Private Apps.'
                )}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="hubspot-portal-id" className="text-sm font-medium">
                HubSpot Portal ID (Optional)
              </Label>
              <Input
                id="hubspot-portal-id"
                placeholder="e.g. 12345678"
                value={portalId}
                onChange={(e) => setPortalId(e.target.value)}
                disabled={!canEditSettings}
              />
              <p className="text-xs text-muted-foreground">
                Your HubSpot account ID, used for direct deep links to contacts in HubSpot.
              </p>
            </div>

            <div className="pt-2 border-t border-border/60 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="auto-sync-message" className="text-sm font-medium cursor-pointer">
                    Sync on WhatsApp Message Received
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically checks if contact email exists in HubSpot (updates if existing, creates if new) when an inbound WhatsApp message arrives.
                  </p>
                </div>
                <Switch
                  id="auto-sync-message"
                  checked={autoSyncOnMessage}
                  onCheckedChange={setAutoSyncOnMessage}
                  disabled={!canEditSettings}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="auto-sync-contacts" className="text-sm font-medium cursor-pointer">
                    Sync on Contact Create & Update
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically sync contacts to HubSpot when added or edited in WhatsCRM.
                  </p>
                </div>
                <Switch
                  id="auto-sync-contacts"
                  checked={autoSyncContacts}
                  onCheckedChange={setAutoSyncContacts}
                  disabled={!canEditSettings}
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-4">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleTest()}
                  disabled={testing || (!hasToken && !accessToken.trim())}
                  className="gap-2"
                >
                  {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                  Test Connection
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowTestSync(!showTestSync)}
                  disabled={!connected && !accessToken.trim()}
                  className="gap-1.5"
                >
                  <Send className="size-3.5" />
                  {showTestSync ? 'Hide Test Sync' : 'Send Test Contact Sync'}
                </Button>
              </div>

              <Button
                type="submit"
                size="sm"
                disabled={saving || !canEditSettings}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin mr-1.5" />
                    Saving...
                  </>
                ) : (
                  'Save Settings'
                )}
              </Button>
            </div>
          </form>

          {/* Test Contact Sync Panel */}
          {showTestSync && (
            <div className="mt-4 p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Send className="size-3.5 text-primary" />
                  Test Sync Contact to HubSpot
                </h4>
                <span className="text-xs text-muted-foreground">Checks email first: updates if exists, creates if new</span>
              </div>
              <form onSubmit={handleRunTestSync} className="grid sm:grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="test-name" className="text-xs">Full Name</Label>
                  <Input
                    id="test-name"
                    value={testName}
                    onChange={(e) => setTestName(e.target.value)}
                    className="h-8 text-xs mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="test-email" className="text-xs">Email Address</Label>
                  <Input
                    id="test-email"
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    className="h-8 text-xs mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="test-phone" className="text-xs">Phone Number</Label>
                  <Input
                    id="test-phone"
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                    className="h-8 text-xs mt-1"
                  />
                </div>
                <div className="sm:col-span-3 flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={runningTestSync}
                    className="gap-1.5 bg-primary text-primary-foreground"
                  >
                    {runningTestSync ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
                    Sync Contact to HubSpot Now
                  </Button>
                </div>
              </form>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sync Activity Logs Card */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              HubSpot Sync Logs & Activity
            </CardTitle>
            <CardDescription className="text-xs">
              Real-time audit log of contacts created, updated, or synced with HubSpot.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={fetchLogs}
              disabled={loadingLogs}
              title="Refresh logs"
            >
              <RefreshCw className={`size-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
            </Button>
            {logs.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleClearLogs}
                disabled={clearingLogs}
                title="Clear logs"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <div className="py-10 px-4 text-center">
              <Activity className="size-8 mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium text-foreground">No sync activity recorded yet</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto mt-1">
                When a message is received on WhatsApp or a contact is synced, details and results will appear here in real-time.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTestSync(true)}
                className="mt-3 gap-1.5 text-xs"
              >
                <Send className="size-3" />
                Run a Test Sync
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-xs font-semibold">Time</TableHead>
                    <TableHead className="text-xs font-semibold">Action</TableHead>
                    <TableHead className="text-xs font-semibold">Contact</TableHead>
                    <TableHead className="text-xs font-semibold">Source</TableHead>
                    <TableHead className="text-xs font-semibold">HubSpot ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => {
                    const isSuccess = log.status === 'success';
                    const hubspotUrl =
                      portalId && log.hubspot_contact_id
                        ? `https://app.hubspot.com/contacts/${portalId}/contact/${log.hubspot_contact_id}`
                        : null;

                    return (
                      <TableRow key={log.id} className="border-border text-xs">
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {new Date(log.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </TableCell>
                        <TableCell>
                          {isSuccess ? (
                            log.action === 'created' ? (
                              <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-[10px] gap-1">
                                <UserPlus className="size-3" />
                                Created in HubSpot
                              </Badge>
                            ) : (
                              <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 text-[10px] gap-1">
                                <UserCheck className="size-3" />
                                Updated in HubSpot
                              </Badge>
                            )
                          ) : (
                            <Badge className="bg-destructive/10 text-destructive border-destructive/20 text-[10px] gap-1">
                              <XCircle className="size-3" />
                              Failed
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-foreground">
                            {log.contact_name || log.email || log.phone || 'Unnamed'}
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                            {log.email && <span>{log.email}</span>}
                            {log.phone && <span>{log.phone}</span>}
                          </div>
                          {log.error_message && (
                            <div className="text-[11px] text-destructive mt-0.5">
                              {log.error_message}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                            {formatSource(log.source)}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {log.hubspot_contact_id ? (
                            hubspotUrl ? (
                              <a
                                href={hubspotUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                {log.hubspot_contact_id}
                                <ExternalLink className="size-2.5" />
                              </a>
                            ) : (
                              <span className="text-foreground">{log.hubspot_contact_id}</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Setup Guide Card */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            How to Create a HubSpot Private App
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <ol className="list-decimal list-inside space-y-2">
            <li>Log into your HubSpot account and click the <strong>Settings (gear icon)</strong> in the top navigation.</li>
            <li>In the left sidebar, navigate to <strong>Integrations → Private Apps</strong>.</li>
            <li>Click <strong>Create a private app</strong> and name it (e.g. <em>WhatsCRM Integration</em>).</li>
            <li>
              Go to the <strong>Scopes</strong> tab and ensure you grant the following permissions:
              <ul className="list-disc list-inside ml-4 mt-1 space-y-1 font-mono text-[11px] text-foreground">
                <li>crm.objects.contacts.read</li>
                <li>crm.objects.contacts.write</li>
              </ul>
            </li>
            <li>Click <strong>Create app</strong> and confirm by clicking <strong>Continue creating</strong>.</li>
            <li>Click <strong>Show token</strong>, copy the access token (starts with <code className="text-primary">pat-</code>), and paste it into the field above.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
