import { parseOpenbotAttachmentHref, type EnvironmentId } from "@t3tools/contracts";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Attachment } from "./Attachment";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Render messages, resolving durable file references through the current connection. */
export function Markdown({
  text,
  environmentId,
}: {
  readonly text: string;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <div className="openbot-markdown text-[15px] leading-relaxed sm:text-sm">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={{
          a: ({ href, children }) => {
            const attachment = href === undefined ? undefined : parseOpenbotAttachmentHref(href);
            return attachment === undefined ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <Attachment attachment={attachment} environmentId={environmentId} />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
