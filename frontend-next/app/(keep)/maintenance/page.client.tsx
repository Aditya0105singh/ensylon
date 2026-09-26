"use client";

import { useState } from "react";
import { Badge, Button, Card, Switch, Text, TextInput } from "@tremor/react";
import { MdOutlineEventBusy, MdOutlineDeleteOutline } from "react-icons/md";
import {
  EmptyStateCard,
  KeepLoader,
  PageHero,
  showErrorToast,
  showSuccessToast,
} from "@/shared/ui";
import {
  useMaintenanceWindows,
  useMaintenanceWindowActions,
} from "@/entities/alertlens";
import { DataTable, TableHead, Th, Tr, Td } from "@/entities/alertlens/ui/Table";
import type { MaintenanceWindow } from "@/entities/alertlens";

// <input type="datetime-local"> both displays and parses in the browser's
// own local timezone, with no offset info attached either way. Prefill in
// local time (what a user expects to see and edit), then convert to UTC
// only at submit time - the backend's start_time/end_time are naive but
// implicitly UTC (compared against datetime.utcnow()).
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function localInputToUtcIso(value: string): string {
  // `new Date(value)` parses a timezone-less datetime-local string as local
  // time, so .toISOString() below gives the correct UTC equivalent.
  return new Date(value).toISOString().slice(0, 19);
}

function AddWindowForm({
  onAdd,
}: {
  onAdd: (name: string, service: string, start: string, end: string) => Promise<void>;
}) {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [start, setStart] = useState(toLocalInputValue(now));
  const [end, setEnd] = useState(toLocalInputValue(inOneHour));
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !start || !end) return;
    setSubmitting(true);
    try {
      await onAdd(
        name.trim(),
        service.trim(),
        localInputToUtcIso(start),
        localInputToUtcIso(end)
      );
      setName("");
      setService("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <Text className="text-xs mb-1">Name</Text>
            <TextInput
              placeholder="e.g. Weekly database patching"
              value={name}
              onValueChange={setName}
            />
          </div>
          <div className="flex-1">
            <Text className="text-xs mb-1">Service (blank = all)</Text>
            <TextInput
              placeholder="e.g. postgres-primary"
              value={service}
              onValueChange={setService}
            />
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1 w-full">
            <Text className="text-xs mb-1">Start</Text>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full rounded-tremor-default border border-tremor-border px-2.5 py-1.5 text-sm shadow-tremor-input"
            />
          </div>
          <div className="flex-1 w-full">
            <Text className="text-xs mb-1">End</Text>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full rounded-tremor-default border border-tremor-border px-2.5 py-1.5 text-sm shadow-tremor-input"
            />
          </div>
          <Button type="submit" color="emerald" loading={submitting} disabled={submitting}>
            Add window
          </Button>
        </div>
      </form>
    </Card>
  );
}

function statusBadge(w: MaintenanceWindow) {
  if (!w.enabled) return <Badge color="gray" size="xs">disabled</Badge>;
  if (w.active) return <Badge color="orange" size="xs">suppressing now</Badge>;
  const started = new Date(w.start_time + "Z") <= new Date();
  return started ? (
    <Badge color="gray" size="xs">expired</Badge>
  ) : (
    <Badge color="blue" size="xs">scheduled</Badge>
  );
}

function WindowRow({ window: w }: { window: MaintenanceWindow }) {
  const { setEnabled, deleteWindow } = useMaintenanceWindowActions();
  const [busy, setBusy] = useState(false);

  const handleToggle = async (value: boolean) => {
    setBusy(true);
    try {
      await setEnabled(w.id, value);
    } catch (error) {
      showErrorToast(error, "Failed to update window");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete maintenance window "${w.name}"?`)) return;
    setBusy(true);
    try {
      await deleteWindow(w.id);
    } catch (error) {
      showErrorToast(error, "Failed to delete window");
      setBusy(false);
    }
  };

  return (
    <Tr>
      <Td>
        <span className="font-medium">{w.name}</span>
      </Td>
      <Td>
        <span className="text-xs text-gray-500">{w.service ?? "all services"}</span>
      </Td>
      <Td>
        <span className="text-xs text-gray-500 font-mono">
          {new Date(w.start_time + "Z").toLocaleString()} →{" "}
          {new Date(w.end_time + "Z").toLocaleString()}
        </span>
      </Td>
      <Td>{statusBadge(w)}</Td>
      <Td>
        <div className="flex items-center gap-2 justify-end">
          <Switch checked={w.enabled} onChange={handleToggle} disabled={busy} />
          <Button
            size="xs"
            variant="secondary"
            color="red"
            icon={MdOutlineDeleteOutline}
            disabled={busy}
            onClick={handleDelete}
          />
        </div>
      </Td>
    </Tr>
  );
}

export default function MaintenancePage() {
  const { data: windows, isLoading, error } = useMaintenanceWindows();
  const { createWindow } = useMaintenanceWindowActions();

  const handleAdd = async (
    name: string,
    service: string,
    start: string,
    end: string
  ) => {
    try {
      await createWindow(name, service || null, start, end);
      showSuccessToast(`Added maintenance window "${name}"`);
    } catch (err) {
      showErrorToast(err, "Failed to add maintenance window");
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={MdOutlineEventBusy}
        title="Maintenance"
        subtitle="Real time windows that suppress alerts from a service — evaluated against the clock on every pipeline run, not a manual per-alert dismiss."
      />

      <AddWindowForm onAdd={handleAdd} />

      {isLoading ? (
        <KeepLoader includeMinHeight={false} loadingText="Loading maintenance windows..." />
      ) : error ? (
        <EmptyStateCard
          icon={MdOutlineEventBusy}
          title="Could not load maintenance windows"
          description={String(error)}
        />
      ) : !windows || windows.length === 0 ? (
        <Card>
          <EmptyStateCard
            noCard
            icon={MdOutlineEventBusy}
            title="No maintenance windows yet"
            description="Add one above to start suppressing a service's alerts on a schedule."
          />
        </Card>
      ) : (
        <Card>
          <DataTable>
            <TableHead>
              <Th>Name</Th>
              <Th>Service</Th>
              <Th>Window</Th>
              <Th>Status</Th>
              <Th className="text-right">Enabled</Th>
            </TableHead>
            <tbody>
              {windows.map((w) => (
                <WindowRow key={w.id} window={w} />
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}
    </div>
  );
}
