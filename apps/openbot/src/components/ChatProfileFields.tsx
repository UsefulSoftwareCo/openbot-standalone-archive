import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { Input } from "@t3tools/ui/input";
import { useId } from "react";
import { providerModelSelection, useServerProviders } from "../state/providers";

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
  allowAutomatic = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ChatProfileDraft;
  readonly onChange: (draft: ChatProfileDraft) => void;
  readonly disabled: boolean;
  readonly allowAutomatic?: boolean;
}) {
  const { items: providers, failed: providerError } = useServerProviders(environmentId);
  const modelListId = useId();
  const selected = providers.find(
    (provider) => provider.instanceId === value.modelSelection?.instanceId,
  );
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
      <label className="flex flex-col gap-1 text-sm">
        Provider
        <select
          className="h-9 rounded-md border border-border bg-background px-2"
          value={value.modelSelection?.instanceId ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              modelSelection: providerModelSelection(providers, event.target.value),
            })
          }
        >
          {allowAutomatic && <option value="">Automatic</option>}
          {value.modelSelection !== undefined && selected === undefined && (
            <option value={value.modelSelection.instanceId}>
              {value.modelSelection.instanceId}
            </option>
          )}
          {providers.map((provider) => (
            <option key={provider.instanceId} value={provider.instanceId}>
              {provider.displayName ?? provider.instanceId}
            </option>
          ))}
        </select>
      </label>
      {value.modelSelection !== undefined && (
        <label className="flex flex-col gap-1 text-sm">
          Model
          <Input
            list={modelListId}
            value={value.modelSelection.model}
            onChange={(event) => {
              if (value.modelSelection !== undefined)
                onChange({
                  ...value,
                  modelSelection: { ...value.modelSelection, model: event.target.value },
                });
            }}
          />
          <datalist id={modelListId}>
            {selected?.models.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.name}
              </option>
            ))}
          </datalist>
        </label>
      )}
      {providerError && (
        <p role="alert" className="text-xs text-error-foreground">
          Could not load provider choices. Reopen settings to try again.
        </p>
      )}
    </fieldset>
  );
}
