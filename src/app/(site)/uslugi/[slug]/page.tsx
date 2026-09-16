import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ServicePage } from "@/modules/site/components/content/ServicePage";
import { SERVICES, serviceBySlug } from "@/modules/site/content/services";
import { pageMetadata } from "@/modules/site/seo/metadata";

/**
 * Страницы услуг собираются при сборке по списку услуг; другой адрес под `/uslugi/`
 * отвечает 404 через `notFound()`. Не `dynamicParams = false`: с ним Next 15.5 пишет в
 * лог `Error: Internal: NoFallbackError` со стеком на каждый такой запрос, и перебор
 * адресов роботом выглядел бы в логах площадки как поток ошибок.
 */
type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return SERVICES.map((service) => ({ slug: service.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const service = serviceBySlug((await params).slug);
  if (!service) notFound();
  return pageMetadata(service.path);
}

export default async function ServiceRoute({ params }: Props) {
  const service = serviceBySlug((await params).slug);
  if (!service) notFound();
  return <ServicePage service={service} />;
}
