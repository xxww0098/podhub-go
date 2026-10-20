/**
 * 六行说明的可复用俄文片段词库——给不读俄文的构建者的「积木」。
 * 内容全部摘自 prompts/ 仓库已通过 validate_brief 的真实说明与 skill
 * lines.md 的标准句；只收跨商品成立的固定句，商品事实（名词/规格/材质）
 * 一律不预填，靠同款/同类目复制起稿。
 */
import type { BriefLineKey, BriefValues } from "./brief-lines"

export type BriefFragment = {
  /** 可直接插入行内的俄文片段。 */
  ru: string
  /** 中文意思——构建者看得懂自己在插什么。 */
  zh: string
  /** 需要按本商品事实核对/删改时点明。 */
  caution?: boolean
}

export const BRIEF_FRAGMENTS: Record<BriefLineKey, readonly BriefFragment[]> = {
  goods: [
    {
      ru: "Материал и комплектация не подтверждены",
      zh: "材质与成套内容未确认（问不到事实时写）",
    },
    {
      ru: "Модель — только совместимость, не бренд товара.",
      zh: "型号只表兼容，不是品牌（型号类商品用）",
    },
  ],
  theme: [
    {
      ru: "Только принт, без реквизита съёмки и фона. Неясно → «Абстрактный принт».",
      zh: "印花商品标准主题句：只取印花、排除拍摄道具、兜底抽象印花",
    },
    {
      ru: "Только видимое. Неясно → «Абстрактная композиция».",
      zh: "整幅画面即商品（画类）的主题句",
    },
    {
      ru: "Текст на принте → «с надписью» или его смысл по-русски, без транслитерации.",
      zh: "画面带文字时的处理",
      caution: true,
    },
  ],
  title: [
    {
      ru: "Размер только с кириллической «х».",
      zh: "公式里有尺寸时，公式之后必补这句",
    },
  ],
  forbidden: [],
  description: [
    {
      ru: "Принт: <видимый принт>.",
      zh: "描述第 3 句：印花槽",
    },
    {
      ru: "Сюжет: <видимый сюжет>.",
      zh: "描述第 3 句（整幅画面即商品时用这句）",
    },
    {
      ru: "Основные цвета: <цвет1> и <цвет2>.",
      zh: "描述第 4 句：主色槽",
    },
    {
      ru: "Подойдёт для дома и офиса и станет подарком тем, кто любит <тема или стиль>.",
      zh: "描述第 5 句场景示例——使用场景必须与商品一致，按事实改",
      caution: true,
    },
  ],
  invented: [
    {
      ru: "материал, размер, вес, упаковку и комплект",
      zh: "未确认项通用清单——按 Товар 里标的未确认项删改",
      caution: true,
    },
    {
      ru: "стойкость принта, крепление и сертификаты",
      zh: "常见延伸禁造项——只列本商品确实没确认的",
      caution: true,
    },
  ],
}

/**
 * 骨架句：只填跨商品恒成立的模板句（主题句 + 描述两个槽句），且只补
 * 空字段、绝不覆盖已写内容；商品事实行（商品/标题/禁词）留给构建者。
 */
export function skeletonBriefValues(current: BriefValues): BriefValues {
  const next = { ...current }
  if (!next.theme.trim()) {
    next.theme = BRIEF_FRAGMENTS.theme[0].ru
  }
  if (!next.description.trim()) {
    next.description = [
      BRIEF_FRAGMENTS.description[0].ru,
      BRIEF_FRAGMENTS.description[2].ru,
    ].join(" ")
  }
  return next
}
