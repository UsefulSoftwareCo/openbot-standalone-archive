export function PairingGate({ errorMessage }: { readonly errorMessage: string | null }) {
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xs">
        <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
          OpenBot
        </p>
        <h1 className="mt-2 font-semibold text-xl tracking-tight">Pair this browser</h1>
        <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
          Open the pairing link the OpenBot host printed when it started. It signs this browser in
          once; after that your chats load directly.
        </p>
        {errorMessage !== null && (
          <p className="mt-3 text-error-foreground text-sm">{errorMessage}</p>
        )}
      </section>
    </div>
  );
}
