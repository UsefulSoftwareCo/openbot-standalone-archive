import {
  isProviderAvailable,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { Input } from "@t3tools/ui/input";
import { Button } from "@t3tools/ui/button";
import { useEffect, useId, useState } from "react";
import { getServerConfig, useAtomCommand } from "../state/channels";
import { TerminalAvatar } from "./TerminalAvatar";

/** Editable chat identity and next-message model selection. */
export interface ChatProfileDraft {
  readonly name: string;
  readonly avatar: string;
  readonly description: string;
  readonly modelSelection: ModelSelection | undefined;
}

/** A local avatar never fetches an external image URL. */
export function ChatAvatar({
  avatar,
  name,
  className = "size-7",
}: {
  readonly avatar: string;
  readonly name: string;
  readonly className?: string;
}) {
  if (avatar === "") return <TerminalAvatar name={name} className={className} />;
  return avatar.startsWith("data:image/") ? (
    <img src={avatar} alt="" className={`${className} shrink-0 rounded-lg object-cover`} />
  ) : (
    <span
      aria-hidden="true"
      className={`${className} grid shrink-0 place-items-center rounded-lg bg-muted text-sm`}
    >
      {avatar}
    </span>
  );
}

/** Shared creation/settings fields; provider choices come from the connected server. */
export function ChatProfileFields({
  environmentId,
  value,
  onChange,
  disabled,
  allowAutomatic = true,
  onBusyChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ChatProfileDraft;
  readonly onChange: (draft: ChatProfileDraft) => void;
  readonly disabled: boolean;
  readonly allowAutomatic?: boolean;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const readProviders = useAtomCommand(getServerConfig, { reportFailure: false });
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  const [providerError, setProviderError] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const modelListId = useId();
  useEffect(() => {
    let disposed = false;
    void readProviders({ environmentId, input: {} }).then((result) => {
      if (disposed) return;
      if (result._tag === "Failure") setProviderError(true);
      else {
        setProviderError(false);
        setProviders(
          result.value.providers.filter(
            (provider) => isProviderAvailable(provider) && provider.enabled && provider.installed,
          ),
        );
      }
    });
    return () => {
      disposed = true;
    };
  }, [environmentId, readProviders]);
  const selected = providers.find(
    (provider) => provider.instanceId === value.modelSelection?.instanceId,
  );
  const uploadAvatar = async (file: File) => {
    setAvatarBusy(true);
    onBusyChange(true);
    setAvatarError(null);
    try {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
        setAvatarError("Choose an image up to 10 MB.");
        return;
      }
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 96;
        const context = canvas.getContext("2d");
        if (context === null) {
          setAvatarError("This browser cannot prepare the image.");
          return;
        }
        const size = Math.min(bitmap.width, bitmap.height);
        context.drawImage(
          bitmap,
          (bitmap.width - size) / 2,
          (bitmap.height - size) / 2,
          size,
          size,
          0,
          0,
          96,
          96,
        );
        onChange({ ...value, avatar: canvas.toDataURL("image/webp", 0.85) });
      } finally {
        bitmap.close();
      }
    } catch {
      setAvatarError("Could not read this image. Try PNG or JPEG.");
    } finally {
      setAvatarBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <fieldset disabled={disabled || avatarBusy} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input
          autoComplete="off"
          value={value.name}
          maxLength={80}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <div className="flex items-center gap-3">
        <ChatAvatar avatar={value.avatar} name={value.name} className="size-12" />
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          Avatar emoji
          <Input
            value={value.avatar.startsWith("data:image/") ? "" : value.avatar}
            maxLength={16}
            placeholder="e.g. 🌱"
            onChange={(event) => onChange({ ...value, avatar: event.target.value })}
          />
        </label>
        <Button type="button" variant="ghost" onClick={() => onChange({ ...value, avatar: "" })}>
          Reset
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Upload avatar
        <input
          type="file"
          accept="image/*"
          className="text-xs"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void uploadAvatar(file);
            event.target.value = "";
          }}
        />
      </label>
      {avatarError !== null && (
        <p role="alert" className="text-xs text-error-foreground">
          {avatarError}
        </p>
      )}
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
          onChange={(event) => {
            const provider = providers.find((entry) => entry.instanceId === event.target.value);
            const model = provider?.models.find((entry) => entry.isDefault) ?? provider?.models[0];
            onChange({
              ...value,
              modelSelection:
                provider === undefined || model === undefined
                  ? undefined
                  : { instanceId: provider.instanceId, model: model.slug },
            });
          }}
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
