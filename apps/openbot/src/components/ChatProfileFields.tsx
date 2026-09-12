import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { Input } from "@t3tools/ui/input";
import { ModelPicker } from "./ModelPicker";
import { useServerProviders } from "../state/providers";

/** Editable chat identity and next-message model selection. */
export interface ChatProfileDraft {
  readonly name: string;
  readonly avatar: string;
  readonly description: string;
  readonly modelSelection: ModelSelection | undefined;
}

/** Shared creation/settings fields; provider choices come from the connected server. */
export function ChatProfileFields({
  environmentId,
  value,
  onChange,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ChatProfileDraft;
  readonly onChange: (draft: ChatProfileDraft) => void;
  readonly disabled: boolean;
}) {
  const { items: providers, failed: providerError } = useServerProviders(environmentId);
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input
          autoComplete="off"
          value={value.name}
          maxLength={80}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Description
        <textarea
          className="min-h-20 rounded-md border border-border bg-background p-2"
          value={value.description}
          maxLength={2000}
          placeholder="What this chat is for"
          onChange={(event) => onChange({ ...value, description: event.target.value })}
        />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span>Model</span>
        <ModelPicker
          providers={providers}
          selection={value.modelSelection}
          disabled={disabled}
          onChange={(modelSelection) => onChange({ ...value, modelSelection })}
        />
      </div>
      {providerError && (
        <p role="alert" className="text-xs text-error-foreground">
          Could not load provider choices. Reopen settings to try again.
        </p>
      )}
    </fieldset>
  );
}
