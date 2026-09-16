import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckWizard } from "@/modules/site/components/check/CheckWizard";
import { selfCheckExists } from "@/modules/self-check/service";
import { checkPageMetadata } from "@/modules/site/seo/metadata";

/**
 * Мастер проверки. Данные конкретного человека приходят только через
 * `/api/self-check/*` — страница в поиск не попадает.
 *
 * Базу страница спрашивает об одном: есть ли такая проверка. Неизвестный адрес
 * отвечает кодом 404, а не экраном «не найдена» с кодом 200 — для ссылки с
 * опечаткой и для робота это разные ответы.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = checkPageMetadata;

type Props = { params: Promise<{ publicId: string }> };

export default async function CheckPage({ params }: Props) {
  const { publicId } = await params;
  if (!(await selfCheckExists(publicId))) notFound();
  return <CheckWizard publicId={publicId} />;
}
