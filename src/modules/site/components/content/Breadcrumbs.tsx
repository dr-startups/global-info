import Link from "next/link";
import { breadcrumbsFor } from "@/modules/site/content/pages";

/** Хлебные крошки из реестра: те же, что в разметке BreadcrumbList. */
export function Breadcrumbs({ path }: { path: string }) {
  const crumbs = breadcrumbsFor(path);
  return (
    <ol className="site-breadcrumbs" aria-label="Вы здесь">
      {crumbs.map((crumb, i) => (
        <li key={crumb.path}>{i < crumbs.length - 1 ? <Link href={crumb.path}>{crumb.name}</Link> : crumb.name}</li>
      ))}
    </ol>
  );
}
