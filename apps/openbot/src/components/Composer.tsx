import { Button } from "@t3tools/ui/button";
import { Textarea } from "@t3tools/ui/textarea";
import { ArrowUp } from "lucide-react";
import { useState } from "react";

export function Composer({
  channelName,
  disabled,
  onSend,
}: {
  readonly channelName: string;
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  const submit = async () => {
    if (trimmed.length === 0 || disabled) return;
    // Clear immediately: the message is accepted server-side and shows up in
    // the timeline with its own state, so the composer never blocks on a turn.
    setValue("");
    const accepted = await onSend(trimmed);
    if (!accepted) setValue(trimmed);
  };

  return (
    <form
      className="flex items-end gap-2 border-t border-border bg-background px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        rows={1}
        aria-label={`Message ${channelName}`}
        placeholder={`Message ${channelName}`}
        value={value}
        className="[&_textarea]:max-h-40 [&_textarea]:min-h-9 [&_textarea]:max-sm:min-h-10"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <Button
        type="submit"
        size="icon"
        aria-label="Send"
        disabled={trimmed.length === 0 || disabled}
      >
        <ArrowUp />
      </Button>
    </form>
  );
}
