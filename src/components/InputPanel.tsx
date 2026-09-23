import { useRef, useState } from "react";

interface InputPanelProps {
  step: number;
  title: string;
  hint: string;
  accept: string;
  placeholder: string;
  text: string;
  onTextChange: (value: string) => void;
  onFile: (file: File) => void;
  status?: { kind: "ok" | "error" | "busy"; message: string } | null;
  tall?: boolean;
  className?: string;
}

export function InputPanel({
  step,
  title,
  hint,
  accept,
  placeholder,
  text,
  onTextChange,
  onFile,
  status,
  tall,
  className,
}: InputPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div className={`panel flex flex-col p-4 ${className ?? ""}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary-soft font-mono text-[11px] font-bold text-primary">
          {step}
        </span>
        <h2 className="font-display text-sm font-semibold">{title}</h2>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          optional
        </span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{hint}</p>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={`w-full rounded-md border-2 border-dashed px-3 py-4 text-xs transition-colors ${
          dragging
            ? "border-primary bg-primary-soft text-primary"
            : "border-border text-muted-foreground hover:border-primary hover:bg-primary-soft/40"
        }`}
      >
        Drop {accept} here, or click to browse
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />

      {status ? (
        <p
          className={`mt-2 font-mono text-[11px] ${
            status.kind === "error"
              ? "text-destructive"
              : status.kind === "ok"
                ? "text-success"
                : "text-muted-foreground"
          }`}
        >
          {status.message}
        </p>
      ) : null}

      <div className="my-2 flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or paste
        <span className="h-px flex-1 bg-border" />
      </div>

      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder={placeholder}
        className={`field resize-y leading-relaxed ${tall ? "min-h-32" : "min-h-20"}`}
      />
    </div>
  );
}
