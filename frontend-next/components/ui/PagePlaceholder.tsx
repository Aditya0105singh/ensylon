import { EmptyStateCard } from "@/shared/ui";

type PagePlaceholderProps = {
  title: string;
  description: string;
  icon?: React.ElementType;
};

/**
 * Themed placeholder for routes whose AlertLens data wiring lands in a later
 * migration phase. Keeps the shell fully navigable.
 */
export function PagePlaceholder({
  title,
  description,
  icon,
}: PagePlaceholderProps) {
  return (
    <div className="flex flex-col h-full p-4">
      <EmptyStateCard title={title} description={description} icon={icon} />
    </div>
  );
}
