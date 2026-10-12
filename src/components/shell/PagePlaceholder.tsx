import type { ReactNode } from "react";
import { Construction } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/States";

interface PagePlaceholderProps {
  title: string;
  /** ein Satz: was die Seite zeigen wird */
  description?: ReactNode;
  /** optionaler Inhalt unter dem Hinweis (z. B. Link zur Komponenten-Vorschau) */
  children?: ReactNode;
}

/** Platzhalter, bis die eigentliche Seite gebaut ist: Seitenkopf + Hinweis. */
export function PagePlaceholder({ title, description, children }: PagePlaceholderProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Panel>
        <EmptyState icon={Construction} title="Diese Seite wird gerade gebaut.">
          {children}
        </EmptyState>
      </Panel>
    </>
  );
}
