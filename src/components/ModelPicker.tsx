import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { RUN_BUDGET_INR, runCostInr, type ModelPreset } from "@/lib/llm";

/** Searchable model dropdown; a typed id that isn't in the list can still be used as-is. */
export function ModelPicker({
  id,
  value,
  models,
  onChange,
}: {
  id?: string;
  value: string;
  models: ModelPreset[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const canUseTyped = q && !models.some((m) => m.id === q);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          className="field flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="truncate font-mono text-xs">{value || "Select a model…"}</span>
          <span className="text-muted-foreground">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput
            placeholder={`Search ${models.length} models…`}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No matching model.</CommandEmpty>
            <CommandGroup>
              {canUseTyped ? (
                <CommandItem
                  value={`use-${q}`}
                  forceMount
                  onSelect={() => {
                    onChange(q);
                    setOpen(false);
                  }}
                >
                  Use “{q}”
                </CommandItem>
              ) : null}
              {models.map((m) => (
                <CommandItem
                  key={m.id}
                  value={m.id}
                  onSelect={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {m.id === value ? "✓ " : ""}
                    {m.id}
                  </span>
                  <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                    {m.costKnown === false
                      ? "no price"
                      : m.tier === "FREE"
                        ? "free"
                        : `~₹${runCostInr(m).toFixed(2)}/run${runCostInr(m) <= RUN_BUDGET_INR ? " ✓" : ""}`}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
