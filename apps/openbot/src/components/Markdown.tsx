import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

export function Markdown({ text }: { readonly text: string }) {
  return (
    <div className="openbot-markdown text-[15px] leading-relaxed sm:text-sm">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
}
