import { useEffect, useMemo, useState } from "react"
import { listPublicPlatformCatalog, type PublicPlatformProduct } from "@/bindings/http-public-catalog"
import { buttonVariants } from "@/components/ui/button"
import { CTA, Intro, Shell } from "./public-site-shell"

const CATALOG_PAGE_SIZE = 24

function specEntries(specs: Record<string, string>): Array<[string, string]> {
  return Object.entries(specs).filter(([, value]) => value.trim().length > 0)
}

export function Catalog({ signedIn }: { signedIn: boolean }) {
  const priceHref = signedIn ? "/" : "/login"
  const priceLabel = signedIn ? "进入工作台查看价格" : "登录查看价格"
  const [products, setProducts] = useState<PublicPlatformProduct[]>([])
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [nonce, setNonce] = useState(0)
  const [draft, setDraft] = useState("")
  const [query, setQuery] = useState("")
  const [facets, setFacets] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1)
  const [productId, setProductId] = useState<string>()

  useEffect(() => {
    let live = true
    setStatus("loading")
    listPublicPlatformCatalog()
      .then((rows) => {
        if (!live) return
        setProducts(rows)
        setStatus("ready")
      })
      .catch(() => {
        if (live) setStatus("error")
      })
    return () => {
      live = false
    }
  }, [nonce])

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(draft.trim())
      setPage(1)
    }, 250)
    return () => clearTimeout(timer)
  }, [draft])

  const facetGroups = useMemo(() => {
    const coverage = new Map<string, Map<string, number>>()
    for (const product of products) {
      for (const [key, value] of specEntries(product.specs)) {
        const values = coverage.get(key) ?? new Map<string, number>()
        values.set(value, (values.get(value) ?? 0) + 1)
        coverage.set(key, values)
      }
    }
    return [...coverage.entries()]
      .filter(([, values]) => values.size >= 2)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 4)
      .map(
        ([key, values]) =>
          [
            key,
            [...values.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([value]) => value),
          ] as const,
      )
  }, [products])

  const filtered = useMemo(() => {
    const needle = query.toLowerCase()
    return products.filter((product) => {
      for (const [key, value] of Object.entries(facets)) {
        if (product.specs[key] !== value) return false
      }
      if (!needle) return true
      const haystack = [
        product.title,
        product.description ?? "",
        ...Object.values(product.specs),
        ...product.skus.flatMap((sku) => [
          sku.title,
          sku.platform_code,
          ...Object.values(sku.specs),
        ]),
      ]
        .join("\n")
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [products, query, facets])

  const pages = Math.max(1, Math.ceil(filtered.length / CATALOG_PAGE_SIZE))
  const current = Math.min(page, pages)
  const slice = filtered.slice(
    (current - 1) * CATALOG_PAGE_SIZE,
    current * CATALOG_PAGE_SIZE,
  )
  const selected = products.find((row) => row.product_id === productId)
  const filtering = Boolean(query) || Object.keys(facets).length > 0

  function pickFacet(key: string, value: string) {
    setFacets((now) => {
      const next = { ...now }
      if (next[key] === value) delete next[key]
      else next[key] = value
      return next
    })
    setPage(1)
  }

  function clearFilters() {
    setDraft("")
    setQuery("")
    setFacets({})
    setPage(1)
  }

  return (
    <Shell page="catalog" signedIn={signedIn}>
      <Intro
        title="平台维护的可定制商品目录。"
        body="浏览已上架的平台商品与规格。平台价、建议零售价和下单履约在登录后开放。"
      />
      {selected ? (
        <CatalogProduct
          key={selected.product_id}
          product={selected}
          priceHref={priceHref}
          priceLabel={priceLabel}
          onBack={() => setProductId(undefined)}
        />
      ) : (
        <section className="wrap catalog" aria-label="商品目录">
          <div className="catalog-tools">
            <input
              type="search"
              inputMode="search"
              aria-label="搜索商品"
              placeholder="搜索名称、编号或规格"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p aria-live="polite">
              {status === "ready"
                ? `${filtered.length} 件商品`
                : status === "loading"
                  ? "正在读取目录"
                  : "读不到商品目录"}
            </p>
          </div>

          {status === "ready" && facetGroups.length > 0 ? (
            <div className="catalog-facets">
              {facetGroups.map(([key, values]) => (
                <div className="facet" key={key}>
                  <strong>{key}</strong>
                  {values.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={facets[key] === value}
                      onClick={() => pickFacet(key, value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}

          {status === "error" ? (
            <div className="catalog-empty" role="status">
              <h2>读不到商品目录</h2>
              <p>稍后重试；价格与下单本来就需要登录。</p>
              <button type="button" onClick={() => setNonce((n) => n + 1)}>
                重试
              </button>
            </div>
          ) : status === "ready" && slice.length === 0 ? (
            <div className="catalog-empty" role="status">
              <h2>{products.length === 0 ? "商品目录筹备中" : "没有符合筛选的商品"}</h2>
              <p>
                {products.length === 0
                  ? "平台商品上架后会出现在这里。"
                  : "换个关键词，或清除已选规格。"}
              </p>
              {filtering ? (
                <button type="button" onClick={clearFilters}>
                  清除筛选
                </button>
              ) : null}
            </div>
          ) : (
            <div className="catalog-grid">
              {slice.map((product) => (
                <CatalogCard
                  key={product.product_id}
                  product={product}
                  onOpen={() => setProductId(product.product_id)}
                />
              ))}
            </div>
          )}

          {status === "ready" && pages > 1 ? (
            <nav className="catalog-pager" aria-label="目录分页">
              <button
                type="button"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
              >
                上一页
              </button>
              <span>
                第 {(current - 1) * CATALOG_PAGE_SIZE + 1}–
                {Math.min(current * CATALOG_PAGE_SIZE, filtered.length)} 件，共{" "}
                {filtered.length} 件
              </span>
              <button
                type="button"
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
              >
                下一页
              </button>
            </nav>
          ) : null}
        </section>
      )}
      <CTA
        title="价格只给进来的人看。"
        body="登录后查看平台价与建议零售价，并把商品铺到自己的 Ozon 店铺。"
        label={priceLabel}
        href={priceHref}
      />
    </Shell>
  )
}

function CatalogCard({
  product,
  onOpen,
}: {
  product: PublicPlatformProduct
  onOpen: () => void
}) {
  const image = product.media[0]
  const [broken, setBroken] = useState(false)
  const leadTimes = [
    ...new Set(
      product.skus.map((sku) => sku.lead_time).filter((value) => Boolean(value)),
    ),
  ]
  const specLine = specEntries(product.specs)
    .slice(0, 3)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ")
  return (
    <article className="catalog-card">
      {image && !broken ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="catalog-card-media" aria-hidden>
          暂无图片
        </div>
      )}
      <div className="catalog-card-body">
        <h2>
          <button type="button" onClick={onOpen}>
            {product.title}
          </button>
        </h2>
        {specLine ? <p>{specLine}</p> : null}
        <p>
          {product.skus.length} 个规格
          {leadTimes.length > 0 ? ` · 交期 ${leadTimes.join(" / ")}` : ""}
        </p>
      </div>
    </article>
  )
}

function CatalogProduct({
  product,
  priceHref,
  priceLabel,
  onBack,
}: {
  product: PublicPlatformProduct
  priceHref: string
  priceLabel: string
  onBack: () => void
}) {
  const [image, setImage] = useState(product.media[0])
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set())
  const markBroken = (url: string) =>
    setBroken((previous) => new Set(previous).add(url))
  const shown = image && !broken.has(image) ? image : undefined
  const thumbs = product.media.filter((url) => !broken.has(url))
  return (
    <section className="wrap catalog-detail">
      <button type="button" className="catalog-back" onClick={onBack}>
        ← 返回目录
      </button>
      <div className="catalog-hero">
        <div className="catalog-media">
          {shown ? (
            <img
              src={shown}
              alt={product.title}
              onError={() => markBroken(shown)}
            />
          ) : (
            <div className="catalog-card-media" aria-hidden>
              暂无图片
            </div>
          )}
          {thumbs.length > 1 ? (
            <div className="catalog-thumbs">
              {thumbs.map((url) => (
                <button
                  key={url}
                  type="button"
                  aria-pressed={image === url}
                  onClick={() => setImage(url)}
                >
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={() => markBroken(url)}
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="catalog-facts">
          <h1>{product.title}</h1>
          {product.description ? <p>{product.description}</p> : null}
          {specEntries(product.specs).length > 0 ? (
            <dl>
              {specEntries(product.specs).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <a
            className={`${buttonVariants({ size: "lg" })} nav-login`}
            href={priceHref}
          >
            {priceLabel}
          </a>
        </div>
      </div>
      {product.skus.length > 0 ? (
        <>
          <h2 className="catalog-skus-head">规格（{product.skus.length}）</h2>
          <ul className="catalog-skus">
            {product.skus.map((sku) => (
              <li key={sku.sku_id}>
                {sku.media[0] ? (
                  <img
                    src={sku.media[0]}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(event) => {
                      event.currentTarget.style.display = "none"
                    }}
                  />
                ) : null}
                <div>
                  <strong>{sku.title}</strong>
                  <span>{sku.platform_code}</span>
                  {specEntries(sku.specs).length > 0 ? (
                    <dl>
                      {specEntries(sku.specs).map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
                {sku.lead_time ? <em>交期 {sku.lead_time}</em> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

