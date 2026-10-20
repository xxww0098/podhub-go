# Third-party licenses

由 `scripts/check-third-party-licenses.py` 从 `go list -m all` 生成。不要手改。
更新时运行 `scripts/check-third-party-licenses.py --update`，再提交结果。
检查模式发现与重新扫描的结果不一致时退出码为 1。

本清单只记录每个 Go 模块自己的许可证文件。它不是法律意见。
podhub-go 本身是 `AGPL-3.0-only`，版权持有人 xxww，见根目录 `LICENSE` 与 `NOTICE`。
根目录 `LICENSE` 须与 gnu.org 的 AGPL-3.0 原文逐字节一致，否则脚本退出。

## AGPL-3.0 兼容性

每个模块的许可证须在下列集合内：0BSD、AGPL-3.0、Apache-2.0、BSD-2-Clause、BSD-3-Clause、BSL-1.0、ISC、MIT、MPL-2.0、PostgreSQL、public-domain、Unlicense、Zlib。
集合外的许可证只有逐条复核过的才放行，见下表；其余任何一条都会让脚本退出。

| Module | Version | License | 复核结论 |
| --- | --- | --- | --- |
| github.com/iris-contrib/schema | v0.0.6 | NOASSERTION | 无许可证文件；README.md 的 License 一节是 BSD-3-Clause。不被任何包导入。 |
| github.com/opencontainers/go-digest | v1.0.0 | CC-BY-SA-4.0 | LICENSE.docs 只覆盖文档，代码是 Apache-2.0。只在集成测试中使用。 |
| modernc.org/memory | v1.12.1 | UNKNOWN | LICENSE-LOGO 只是 logo.png 的来源链接，不涉及代码。 |

## AGPL 模块

这些模块与本仓库同为 GNU AGPL-3.0。用户不购买 RelayKit 商业授权，它们按 AGPL-3.0 使用。说明见根目录 `NOTICE`。

| Module | Version | Replace |
| --- | --- | --- |
| github.com/QuantumNous/new-api | v0.0.0 | ./third_party/new-api |
| github.com/QuantumNous/new-api/relaykit | v0.3.4 | - |

## 全部模块

| Module | Version | License | File | SHA-256 | Replace |
| --- | --- | --- | --- | --- | --- |
| dario.cat/mergo | v1.0.2 | BSD-3-Clause | LICENSE | cb7684632b729955293cab8a0bbf4134d53d9532a30761c33c8a4878302a7bd3 | - |
| filippo.io/edwards25519 | v1.2.0 | BSD-3-Clause | LICENSE | 2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067 | - |
| github.com/AdaLogics/go-fuzz-headers | v0.0.0-20240806141605-e8a1dd7889d6 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/Azure/azure-sdk-for-go/sdk/azcore | v1.23.3 | MIT | LICENSE.txt | 646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2 | - |
| github.com/Azure/azure-sdk-for-go/sdk/azidentity | v1.14.1 | MIT | LICENSE.txt | 646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2 | - |
| github.com/Azure/azure-sdk-for-go/sdk/internal | v1.13.0 | MIT | LICENSE.txt | 646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2 | - |
| github.com/Azure/go-ansiterm | v0.0.0-20261006220739-8c912ac31dd4 | MIT | LICENSE | db25a2687ca23d8aedd282353fd23f64f7a0a74b586549cc43080e0a6eabe7b0 | - |
| github.com/AzureAD/microsoft-authentication-library-for-go | v1.10.1 | MIT | LICENSE | 9906940f61b1f0b533fa7d99baf55178b2808fbe113ea51dfbfad8572ccd5f2b | - |
| github.com/BurntSushi/toml | v1.3.2 | MIT | COPYING | d21cb1c60785d6d3a84a7059323ccafc45c645b1bbda281c76a62d66ad2d7dc3 | - |
| github.com/ClickHouse/ch-go | v0.74.0 | Apache-2.0 | LICENSE | 22e7fd421de32ec18e6f9e4f62655696386d9d5dc661722df0b6324351e8cb08 | - |
| github.com/ClickHouse/clickhouse-go/v2 | v2.49.0 | Apache-2.0 | LICENSE | 27099b82691d1d17cb18138319e2a4f9980ef59c1186c9b02a3273c757c0f91b | - |
| github.com/CloudyKit/fastprinter | v0.0.0-20200109182630-33d98a066a53 | MIT | LICENSE | b6da0afb379932657f6065dbf38169c7b62b76f046480d1d68292a66d20d3d66 | - |
| github.com/CloudyKit/jet/v6 | v6.2.0 | Apache-2.0 | LICENSE | b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1 | - |
| github.com/Joker/jade | v1.1.3 | BSD-3-Clause | LICENSE.md | 119c8eaebb0e0ea931e6ebec91ca47e0f140f9b7e132e5a9fc26f5146a864c2b | - |
| github.com/Microsoft/go-winio | v0.6.3 | MIT | LICENSE | cf248820bf1178370bb4f1670a59f8748d46bc96d0f64080cd631511c6046409 | - |
| github.com/QuantumNous/new-api | v0.0.0 | AGPL-3.0 | LICENSE | 8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef | ./third_party/new-api |
| github.com/QuantumNous/new-api/relaykit | v0.3.4 | AGPL-3.0 | LICENSE | 8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef | - |
| github.com/RaveNoX/go-jsoncommentstrip | v1.0.0 | MIT | LICENSE.md | 80c0c1f258e2364312f46c5f6dc1a6ced27593f889d2146369e0b1ae033ecff6 | - |
| github.com/Shopify/goreferrer | v0.0.0-20220729165902-8cddb4f5de06 | MIT | LICENSE | 50f1455a8c576e9d1c1cc2cc987fe4a22ca35a6b7f2ba3a40e7edc874d31c252 | - |
| github.com/andybalholm/brotli | v1.2.6 | MIT | LICENSE | 3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94 | - |
| github.com/antlr4-go/antlr/v4 | v4.13.1 | BSD-2-Clause | LICENSE | 683fcd416d83b64781e229a3c2a598462fbf55c5c9fea54be244766b22c033cf | - |
| github.com/apapsch/go-jsonmerge/v2 | v2.0.0 | MIT | LICENSE | 80c0c1f258e2364312f46c5f6dc1a6ced27593f889d2146369e0b1ae033ecff6 | - |
| github.com/aws/aws-sdk-go-v2 | v1.47.3 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream | v1.7.22 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/config | v1.29.14 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/credentials | v1.20.9 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/feature/ec2/imds | v1.20.3 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/feature/s3/manager | v1.17.75 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/internal/configsources | v1.5.6 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 | v2.8.6 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/internal/ini | v1.8.3 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/internal/v4a | v1.5.6 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding | v1.13.21 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/internal/checksum | v1.11.7 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/internal/presigned-url | v1.14.6 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/internal/s3shared | v1.20.6 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/s3 | v1.114.3 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/signin | v1.10.4 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/sso | v1.38.4 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/ssooidc | v1.43.4 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/aws-sdk-go-v2/service/sts | v1.51.4 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/aws/smithy-go | v1.28.5 | Apache-2.0 | LICENSE | 09e8a9bcec8067104652c168685ab0931e7868f9c8284b66f5ae6edae5f1130b | - |
| github.com/aymerick/douceur | v0.2.0 | MIT | LICENSE | a91ec19456c4efb3d9fc22dc9c1ec60ec3701a9e8f4be511ebcf908c04288ffb | - |
| github.com/bmatcuk/doublestar | v1.1.1 | MIT | LICENSE | 2391eb152e1f700051c1618a7aaa7ad86186585190ca9a30e7579c9b9d459332 | - |
| github.com/bytedance/sonic | v1.11.6 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/bytedance/sonic/loader | v0.1.1 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/cenkalti/backoff/v4 | v4.3.0 | MIT | LICENSE | 5c0476add4c38b55d0ed5ac11b85e00c38f26e1caee20dfe3ab58190103d1fbc | - |
| github.com/cespare/xxhash/v2 | v2.3.0 | MIT | LICENSE.txt | f566a9f97bacdaf00d9f21dd991e81dc11201c4e016c86b470799429a1c9a79c | - |
| github.com/cevatbarisyilmaz/ara | v0.0.4 | MIT | LICENSE | 50376279b5c9fb6e008c24439f065ac9d62735165e895b723e8948060a194e5e | - |
| github.com/cloudwego/base64x | v0.1.4 | Apache-2.0 | LICENSE, LICENSE-APACHE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4, 69849221bfb90053de2134ef5e6d540287b4b98062326492f1f96f5da685524b | - |
| github.com/cloudwego/iasm | v0.2.0 | Apache-2.0 | LICENSE-APACHE | 69849221bfb90053de2134ef5e6d540287b4b98062326492f1f96f5da685524b | - |
| github.com/coder/websocket | v1.8.15 | ISC | LICENSE.txt | cc0975a5f6305145bdd7b41ce9479632fdac3870e6ac4281f28017f18c767c4e | - |
| github.com/containerd/errdefs | v1.0.0 | Apache-2.0 | LICENSE | 4bbe3b885e8cd1907ab4cf9a41e862e74e24b5422297a4f2fe524e6a30ada2b4 | - |
| github.com/containerd/errdefs/pkg | v0.3.0 | Apache-2.0 | LICENSE | 4bbe3b885e8cd1907ab4cf9a41e862e74e24b5422297a4f2fe524e6a30ada2b4 | - |
| github.com/containerd/log | v0.1.0 | Apache-2.0 | LICENSE | 4bbe3b885e8cd1907ab4cf9a41e862e74e24b5422297a4f2fe524e6a30ada2b4 | - |
| github.com/containerd/platforms | v0.2.1 | Apache-2.0 | LICENSE | 4bbe3b885e8cd1907ab4cf9a41e862e74e24b5422297a4f2fe524e6a30ada2b4 | - |
| github.com/containerd/typeurl/v2 | v2.2.0 | Apache-2.0 | LICENSE | 4bbe3b885e8cd1907ab4cf9a41e862e74e24b5422297a4f2fe524e6a30ada2b4 | - |
| github.com/cpuguy83/dockercfg | v0.3.2 | MIT | LICENSE | 6b29b5887ad910cc1743f03989210e1efc5c02297998fbf80960cfc051a8c330 | - |
| github.com/creack/pty | v1.1.24 | MIT | LICENSE | a2a1cea59d9c2d71908082f516f86bb560abf857646ecf69d70c121ead14aef4 | - |
| github.com/davecgh/go-spew | v1.1.2-0.20180830191138-d8f796af33cc | ISC | LICENSE | 1b93a317849ee09d3d7e4f1d20c2b78ddb230b4becb12d7c224c927b9d470251 | - |
| github.com/distribution/reference | v0.6.0 | Apache-2.0 | LICENSE | cb5e8e7e5f4a3988e1063c142c60dc2df75605f4c46515e776e3aca6df976e14 | - |
| github.com/docker/go-connections | v0.8.2 | Apache-2.0 | LICENSE | ba3065d2f4b11bb42a0f7b708b021d1c28fa45d097b3eab3e7db9ab4745040d1 | - |
| github.com/docker/go-units | v0.5.0 | Apache-2.0 | LICENSE | ba3065d2f4b11bb42a0f7b708b021d1c28fa45d097b3eab3e7db9ab4745040d1 | - |
| github.com/dustin/go-humanize | v1.1.0 | MIT | LICENSE | a973b4498c13eb74baa2a8e5c351426a6826f2fcdd909916dbe53ee2e755fd71 | - |
| github.com/ebitengine/purego | v0.10.1 | Apache-2.0 | LICENSE | b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1 | - |
| github.com/elastic/go-sysinfo | v1.15.5 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/elastic/go-windows | v1.0.2 | Apache-2.0 | LICENSE.txt | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/expr-lang/expr | v1.17.8 | MIT | LICENSE | f2c369e1796dc84c37cf34a966033e8850e535567fde32ef74b672726ed61d23 | - |
| github.com/fatih/structs | v1.1.0 | MIT | LICENSE | 8f09e42906e1a3c7bd39629a17225b3b62f25783444d8d75ad5d6657916915df | - |
| github.com/felixge/httpsnoop | v1.1.0 | MIT | LICENSE.txt | 8108e14b5cb2b6bcd51583d3849ef0c2b5c4de61758256c20308bc70d1775dbb | - |
| github.com/flosch/pongo2/v4 | v4.0.2 | MIT | LICENSE | a2f7125b57367cc989d799010f65d329a1c49572174fc3996716db6d0cabb4bd | - |
| github.com/gabriel-vasile/mimetype | v1.4.3 | MIT | LICENSE | 4335e2ceb33d8d7e75125192466ae8604617b0a67492b919604fe52dc56018d9 | - |
| github.com/gin-contrib/sse | v0.1.0 | MIT | LICENSE | 03458b6d5828e1be1127ca2adf122572eb574fc47b56190c3b38203b8b2a98d0 | - |
| github.com/gin-gonic/gin | v1.10.1 | MIT | LICENSE | 03458b6d5828e1be1127ca2adf122572eb574fc47b56190c3b38203b8b2a98d0 | - |
| github.com/go-chi/chi/v5 | v5.5.0 | MIT | LICENSE | a2d51b7515acfaff2f7a88688650f2fc4fd99561383e72bba2305e3db59a1647 | - |
| github.com/go-faster/city | v1.0.1 | MIT | LICENSE | ee60dfaa1cb16b6606355feddfcec03bd7305f335d067e261d36ff20716425fd | - |
| github.com/go-faster/errors | v0.8.0 | BSD-3-Clause | LICENSE | 2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067 | - |
| github.com/go-logr/logr | v1.4.4 | Apache-2.0 | LICENSE | b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1 | - |
| github.com/go-logr/stdr | v1.2.2 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/go-ole/go-ole | v1.3.0 | MIT | LICENSE | d883dbca28769ff23dd4368a8edb7ad9f9f23a8f86adde2875c6e41a828aac62 | - |
| github.com/go-playground/locales | v0.14.1 | MIT | LICENSE | a1a5ca382f9e8c646fa05240a74a6554bbc3084b5675f84c9eaafd3d95686612 | - |
| github.com/go-playground/universal-translator | v0.18.1 | MIT | LICENSE | a55d0c6e1a35ee6cf13afb4bbc3c8801cc570d7ac8edcd5e4503892f1c7ff4f7 | - |
| github.com/go-playground/validator/v10 | v10.20.0 | MIT | LICENSE | 9e321f6a1db81616a6c344d3aefddf9834fef23bdd913eae0db283dfa6753dff | - |
| github.com/go-sql-driver/mysql | v1.10.1 | MPL-2.0 | LICENSE | fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85 | - |
| github.com/goccy/go-json | v0.10.2 | MIT | LICENSE | a707cd425201945d57500566c47c74dc9fb8cd02ef91b9a761abddeb2401e6a7 | - |
| github.com/gogo/protobuf | v1.3.2 | BSD-3-Clause | LICENSE | 3f571768c0ba2f330e5fee90de89bfe5141f48c1939be8008fa61461c30ca07f | - |
| github.com/golang-jwt/jwt/v4 | v4.5.2 | MIT | LICENSE | fe26ca41577b9b2b4448050a24b25e5753af66b5d5945d5d36094e7790bfcb2f | - |
| github.com/golang-jwt/jwt/v5 | v5.3.1 | MIT | LICENSE | fe26ca41577b9b2b4448050a24b25e5753af66b5d5945d5d36094e7790bfcb2f | - |
| github.com/golang-sql/civil | v0.0.0-20220223132316-b832511892a9 | Apache-2.0 | LICENSE | 58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd | - |
| github.com/golang-sql/sqlexp | v0.1.0 | BSD-3-Clause | LICENSE | 17b5d209ba8f9684257ecfcff87df6ceda6194143a8fbd074f29727cff6f0c40 | - |
| github.com/golang/snappy | v0.0.4 | BSD-3-Clause | LICENSE | f69f157b0be75da373605dbc8bbf142e8924ee82d8f44f11bcaf351335bf98cf | - |
| github.com/gomarkdown/markdown | v0.0.0-20240328165702-4d01890c35c0 | BSD-2-Clause | LICENSE.txt | f7b377536d149ca0818e1c341aeca76d63f55ca749cfd713484a1672f89714f7 | - |
| github.com/google/go-cmp | v0.7.0 | BSD-3-Clause | LICENSE | 17b5d209ba8f9684257ecfcff87df6ceda6194143a8fbd074f29727cff6f0c40 | - |
| github.com/google/uuid | v1.6.0 | BSD-3-Clause | LICENSE | 0a8d61ed3cbfd5312326e8126c31ce9c627a283adc99131b56896d29ada04b2d | - |
| github.com/gorilla/css | v1.0.0 | BSD-3-Clause | LICENSE | 877891697e6dd63f64796812ba53c2be4e81d50e8829c109ca9e99ba2f011ffa | - |
| github.com/iris-contrib/schema | v0.0.6 | NOASSERTION | - | - | - |
| github.com/jackc/pgerrcode | v0.0.0-20240316143900-6e2875d9b438 | MIT | LICENSE | ba651777b8362b30d778d60f7a0fcd1f01cdac79aa713d1a6f0a53bf5372fa2f | - |
| github.com/jackc/pgpassfile | v1.0.0 | MIT | LICENSE | adb1663fda031df8f4344aa68f299fd87d80353e31339406742ded21dae65702 | - |
| github.com/jackc/pgservicefile | v0.0.0-20240606120523-5a60cdf6a761 | MIT | LICENSE | fc505773403fe869ed64cc2235cdd13988a427bb7e3a7e7004a3f4b27420f8fc | - |
| github.com/jackc/pgx/v5 | v5.11.0 | MIT | LICENSE | 467f95e074fe23079a5623ed652619682692041b8551da27e3c2ddb9659a1507 | - |
| github.com/jackc/puddle/v2 | v2.2.3 | MIT | LICENSE | 2d50e98a4900b4d6457a38d39c1432fdc156fc2f7b365f2e33ec9344acbb0057 | - |
| github.com/johannesboyne/gofakes3 | v1.2.0 | MIT | LICENSE | 6d969794c2c6ac75038c5ca49db319e8dbaf525b2655345cb4474d7d88045726 | - |
| github.com/joho/godotenv | v1.5.1 | MIT | LICENCE | 4334bf49b7e1a6736ce1b21814d5cce392000204d059ee6a845eeb966e7a1e31 | - |
| github.com/jonboulle/clockwork | v0.5.0 | Apache-2.0 | LICENSE | a8ad31b1c3f40dca5a84119351b8fa8ddc868edd77fad8a8ebf6d8f2d16fa4ae | - |
| github.com/josharian/intern | v1.0.0 | MIT | license.md | ad754e4f7d16f789dd0694828254cb4011928025b0d500339a5c4eded5a0c346 | - |
| github.com/json-iterator/go | v1.1.12 | MIT | LICENSE | 3247931083f058b00760a3c32a9ca0962c05e4d562ad2ffcc1753451fa8d4486 | - |
| github.com/juju/gnuflag | v0.0.0-20171113085948-2ce1bb71843d | BSD-3-Clause | LICENSE | dd26a7abddd02e2d0aba97805b31f248ef7835d9e10da289b22e3b8ab78b324d | - |
| github.com/kataras/blocks | v0.0.8 | MIT | LICENSE | a9addf727c97e408f4acb0b00e158f4d8fbdb94dd01630f2f6648945e205e61b | - |
| github.com/kataras/golog | v0.1.11 | BSD-3-Clause | LICENSE | 0933beadb7b41b782a7303d0eecb91f99fd82e5ed7a0812575fcc6ee2ff1510a | - |
| github.com/kataras/iris/v12 | v12.2.11 | BSD-3-Clause | LICENSE | f051a5b4c28ed4ffbccf5914bad9587689282d8c8b937f7ad09d8cb665c55978 | - |
| github.com/kataras/pio | v0.0.13 | BSD-3-Clause | LICENSE | 95fadf4ce7f42d36ab114cda872308e60120e1067543cded7aed0968c1f2f814 | - |
| github.com/kataras/sitemap | v0.0.6 | MIT | LICENSE | 2cd59d1ac18d2f07241821422148572f88395a97040c2fded735f9111cd7dafc | - |
| github.com/kataras/tunnel | v0.0.4 | MIT | LICENSE | e8b0c0ec56269085de72b06c8de5b1c26349a17e98dba7be304be01a35e47dfc | - |
| github.com/klauspost/compress | v1.20.1 | Apache-2.0 | LICENSE | 0d9e582ee4bff57bf1189c9e514e6da7ce277f9cd3bc2d488b22fbb39a6d87cf | - |
| github.com/klauspost/cpuid/v2 | v2.2.7 | MIT | LICENSE | 5d966570d7a442d4e969892860a914e542c97f262c873baee8f0aa48e1f40212 | - |
| github.com/kr/pretty | v0.3.1 | MIT | License | 283c28b781bc7487bd7bcaf453cbd811f5ee8d7ce625cfcf8dcacae6ba1f4bb5 | - |
| github.com/kylelemons/godebug | v1.1.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/labstack/echo/v4 | v4.15.1 | MIT | LICENSE | 90a303827ab52d3c74ea8d7348a73a1db60dbb44bccba6d8b7f5d25219433fd3 | - |
| github.com/labstack/gommon | v0.4.2 | MIT | LICENSE | 9d05703aa2718dfafeb7ba6bbac3c3ac87ac4ae29e62a23f3f1870eeba67c7e7 | - |
| github.com/leodido/go-urn | v1.4.0 | MIT | LICENSE | fe81a9072afbfe0fe32b0bc99a852d697d14fbbca99b0b1878ac8f5dcbdd6ee6 | - |
| github.com/lib/pq | v1.10.9 | MIT | LICENSE.md | 3e2d79d27727d59ab1c9752f57654733d6c8824936c22800594dccfe8864ec28 | - |
| github.com/lufia/plan9stats | v0.0.0-20260330125221-c963978e514e | BSD-3-Clause | LICENSE | 879acfe02d3790e0bcdd1ee2299fd8576995eaa94c7e14d1a94ee3e018ad7bc2 | - |
| github.com/magiconair/properties | v1.8.10 | BSD-2-Clause | LICENSE.md | 0b3944fe6ccfdffd9b4de92a401c127d3d71d3bb91d6f793a05ba1a9ed751805 | - |
| github.com/mailgun/raymond/v2 | v2.0.48 | MIT | LICENSE | a91ec19456c4efb3d9fc22dc9c1ec60ec3701a9e8f4be511ebcf908c04288ffb | - |
| github.com/mailru/easyjson | v0.7.7 | MIT | LICENSE | 87baa92c3100cf37441761262d622db99492ee386a063460d4676143db49af57 | - |
| github.com/mattn/go-colorable | v0.1.14 | MIT | LICENSE | 88a2379b3ca34bf5c57127aff9dcb802bbb60ece0805cdbda65b3bd115f971d9 | - |
| github.com/mattn/go-isatty | v0.0.24 | MIT | LICENSE | 08eab1118c80885fa1fa6a6dd7303f65a379fcb3733e063d20d1bbc2c76e6fa1 | - |
| github.com/mdelapenya/tlscert | v0.2.0 | MIT | LICENSE | 25f117010926bce616fdb95bbac2766f91c05c3bad6cfb83d872ea0e1f001ef7 | - |
| github.com/mfridman/interpolate | v0.0.2 | MIT | LICENSE.txt | 21408182c12c98d402fa38a8b678560dc63fd6bada5a0017722883e4b79e6620 | - |
| github.com/mfridman/xflag | v0.1.0 | MIT | LICENSE | 2b0c61b2028a8733da226684203395ee7f887c7c660ae3e0a5446379b59db527 | - |
| github.com/microcosm-cc/bluemonday | v1.0.26 | BSD-3-Clause | LICENSE.md | eebdeff001c6211a3d104189a8f754c9a15e60bd9e2534a5b3b16ec9b106ef11 | - |
| github.com/microsoft/go-mssqldb | v1.11.2 | BSD-3-Clause | LICENSE.txt | 7d0793489653bfe020de7ea32047bad266f5e2e204ba12025d5300f39555addc | - |
| github.com/moby/docker-image-spec | v1.3.1 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/moby/go-archive | v0.2.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/moby/api | v1.56.1 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/moby/client | v0.6.2 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/patternmatcher | v0.6.1 | Apache-2.0 | LICENSE | 7c87873291f289713ac5df48b1f2010eb6963752bbd6b530416ab99fc37914a8 | - |
| github.com/moby/sys/mount | v0.3.4 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/sys/mountinfo | v0.7.2 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/sys/reexec | v0.1.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/sys/sequential | v0.7.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/sys/user | v0.4.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/sys/userns | v0.1.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/moby/term | v0.5.2 | Apache-2.0 | LICENSE | 7c87873291f289713ac5df48b1f2010eb6963752bbd6b530416ab99fc37914a8 | - |
| github.com/modern-go/concurrent | v0.0.0-20180306012644-bacd9c7ef1dd | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/modern-go/reflect2 | v1.0.2 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/ncruces/go-strftime | v1.1.0 | MIT | LICENSE | 38ae43959daf953a393a585b2988672cb65a5a541aca0d0be5e72595a0a16883 | - |
| github.com/oapi-codegen/nullable | v1.1.0 | Apache-2.0 | LICENSE | d41218ff141de28756b85f79958bc33e077e9bfa6bd695b5e2b8736b779f5a9d | - |
| github.com/oapi-codegen/runtime | v1.7.0 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/opencontainers/go-digest | v1.0.0 | Apache-2.0 AND CC-BY-SA-4.0 | LICENSE, LICENSE.docs | aceb55133c41c50c2e170c5918e301fe74f592d0f28724bf2f7a7bfdcff1fc5f, a1d1adec3ba691ef6e377a78bbe9e9e2501f2f4a1723d08857da1ac6564e4fed | - |
| github.com/opencontainers/image-spec | v1.1.1 | Apache-2.0 | LICENSE | b0a3f39513927db306adabea11d14c23f079d4febcea241d123a68d1a0d45418 | - |
| github.com/paulmach/orb | v0.13.0 | MIT | LICENSE.md | 91d97518f7a7bd54f8f5fa763a1ae268d23477f37317d787e348d66f56ff7b42 | - |
| github.com/pelletier/go-toml/v2 | v2.2.2 | MIT | LICENSE | 26844e4b53c5adec04e557fd7dfef281cc0205a7d355626b1c68b778b99e9e7b | - |
| github.com/pierrec/lz4/v4 | v4.1.33 | BSD-3-Clause | LICENSE | 6a358d2540ca14048f02d366f23787c0a480157e58f058113f0e27168dd4e447 | - |
| github.com/pkg/browser | v0.0.0-20240102092130-5ac0b6a4141c | BSD-2-Clause | LICENSE | 4801bb0c5d70b980b3e1f63d1d2df8d84fec22548e3d73f03a68df1fb808791f | - |
| github.com/pmezard/go-difflib | v1.0.1-0.20181226105442-5d4384ee4fb2 | BSD-2-Clause | LICENSE | 2eb550be6801c1ea434feba53bf6d12e7c71c90253e0a9de4a4f46cf88b56477 | - |
| github.com/power-devops/perfstat | v0.0.0-20240221224432-82ca36839d55 | MIT | LICENSE | d2568033889c7eb3666ef1cb1f47f84bd49d25847aaad5dd87f18df384238079 | - |
| github.com/pressly/goose/v3 | v3.29.0 | MIT | LICENSE | f23985556a879c0e68bb4e136ee4b88a550d26fa33db77a65d76b721c93093ef | - |
| github.com/prometheus/procfs | v0.22.0 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| github.com/remyoudompheng/bigfft | v0.0.0-20230129092748-24d4a6f8daec | BSD-3-Clause | LICENSE | dd26a7abddd02e2d0aba97805b31f248ef7835d9e10da289b22e3b8ab78b324d | - |
| github.com/riverqueue/river | v0.49.0 | MPL-2.0 | LICENSE | 393eaf2b92b3d49bea139e39b6fd205b6e99c499999986aec5554586a830dfdd | - |
| github.com/riverqueue/river/riverdriver | v0.49.0 | MPL-2.0 | LICENSE | 393eaf2b92b3d49bea139e39b6fd205b6e99c499999986aec5554586a830dfdd | - |
| github.com/riverqueue/river/riverdriver/riverpgxv5 | v0.49.0 | MPL-2.0 | LICENSE | 393eaf2b92b3d49bea139e39b6fd205b6e99c499999986aec5554586a830dfdd | - |
| github.com/riverqueue/river/rivershared | v0.49.0 | MPL-2.0 | LICENSE | 393eaf2b92b3d49bea139e39b6fd205b6e99c499999986aec5554586a830dfdd | - |
| github.com/riverqueue/river/rivertype | v0.49.0 | MPL-2.0 | LICENSE | 393eaf2b92b3d49bea139e39b6fd205b6e99c499999986aec5554586a830dfdd | - |
| github.com/robfig/cron/v3 | v3.0.1 | MIT | LICENSE | 8f650581478707182f3306d9a86676d4e03e2d4edc868344378cf4d6fe6c927a | - |
| github.com/rogpeppe/go-internal | v1.14.1 | BSD-3-Clause | LICENSE | 4835612df0098ca95f8e7d9e3bffcb02358d435dbb38057c844c99d7f725eb20 | - |
| github.com/russross/blackfriday | v1.6.0 | BSD-2-Clause | LICENSE.txt | 449ac384ca2d2262c28c71b402d24ddad03fe42b7e10d03ec1fb1aed604ad771 | - |
| github.com/russross/blackfriday/v2 | v2.1.0 | BSD-2-Clause | LICENSE.txt | 75e1ca97a84a9da6051dee0114333388216f2c4a5a028296b882ff3d57274735 | - |
| github.com/ryszard/goskiplist | v0.0.0-20150312221310-2dfbae5fcf46 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/samber/lo | v1.53.0 | MIT | LICENSE | adb3ac2e3e382989de6befdd489f4714785af8aca47c01193a9892e8b26b3860 | - |
| github.com/santhosh-tekuri/jsonschema/v5 | v5.3.1 | Apache-2.0 | LICENSE | c8858a5a76440bbca484e134cf7df46385d090dd18b2c58e650f939258802e5b | - |
| github.com/schollz/closestmatch | v2.1.0+incompatible | MIT | LICENSE | 0c27314bc4294775c1c7768690fa90b1884a3e27b72b92376ee505963f916e8a | - |
| github.com/segmentio/asm | v1.2.1 | MIT | LICENSE | cca993712df289a5958bdef69031a5dac0f951ac15afeb313f9eeea55ed59443 | - |
| github.com/sethvargo/go-retry | v0.5.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/shirou/gopsutil/v4 | v4.26.6 | BSD-3-Clause | LICENSE | ad1e64b82c04fb2ee6bfe521bff01266971ffaa70500024d4ac767c6033aafb9 | - |
| github.com/shopspring/decimal | v1.5.0 | MIT | LICENSE | b92ba0f6ee02f2309628bfdadb123668a17c016e475ba477b857d33470d9d625 | - |
| github.com/sirupsen/logrus | v1.10.2 | MIT | LICENSE | 51a0c9ec7f8b7634181b8d4c03e5b5d204ac21d6e72f46c313973424664b2e6b | - |
| github.com/spf13/afero | v1.2.1 | Apache-2.0 | LICENSE.txt | 5e3400b93bbb099e83e52bab885e7441750673c21f97988ca3f1240639b63283 | - |
| github.com/spkg/bom | v0.0.0-20160624110644-59b7046e48ad | MIT | LICENSE.md | 322509537142181fdd986a4df98fc2061c56e1c8903085532da5b65d2ad999e2 | - |
| github.com/stretchr/objx | v0.5.3 | MIT | LICENSE | b2663894033a05fd80261176cd8da1d72546e25842d5c1abcc852ca23b6b61b0 | - |
| github.com/stretchr/testify | v1.12.1 | MIT | LICENSE | f8e536c1c7b695810427095dc85f5f80d44ff7c10535e8a9486cf393e2599189 | - |
| github.com/tdewolff/minify/v2 | v2.20.19 | MIT | LICENSE | 0ebcdb0e336d600038ecdb7b8d339d937a66b62cb6d1128896fdc20cfe01c188 | - |
| github.com/tdewolff/parse/v2 | v2.7.12 | MIT | LICENSE.md | 0ebcdb0e336d600038ecdb7b8d339d937a66b62cb6d1128896fdc20cfe01c188 | - |
| github.com/testcontainers/testcontainers-go | v0.44.0 | MIT | LICENSE | a84eddc9908e1c4efacff577eb2885ea0233c75b890dff41c43e86ab67af889a | - |
| github.com/testcontainers/testcontainers-go/modules/postgres | v0.44.0 | MIT | LICENSE | a84eddc9908e1c4efacff577eb2885ea0233c75b890dff41c43e86ab67af889a | - |
| github.com/tetratelabs/wazero | v1.9.0 | Apache-2.0 | LICENSE | c46f033d017a5af71a1de0105ec56c41bd47f81a0bbdf779fffe316336dc7c1f | - |
| github.com/tidwall/gjson | v1.19.0 | MIT | LICENSE | be83ad53208d03a9fe08c7fac231cabf79422989ef5706bff217bd35104ebf07 | - |
| github.com/tidwall/match | v1.2.0 | MIT | LICENSE | be83ad53208d03a9fe08c7fac231cabf79422989ef5706bff217bd35104ebf07 | - |
| github.com/tidwall/pretty | v1.2.1 | MIT | LICENSE | 0ca70311227fe097c662dece3f359e3317fa7f9d41f8d29eb45fc5135e216139 | - |
| github.com/tidwall/sjson | v1.2.5 | MIT | LICENSE | dbf5e2aa91aee5f19a1ce2cc7891e2ac37204b6461c0adc539426636e27b208e | - |
| github.com/tklauser/go-sysconf | v0.4.0 | BSD-3-Clause | LICENSE | fdaaa923d83d44f8b2ed1185600c5aa8c10673f11fba9feb78bd2816786fd6be | - |
| github.com/tklauser/numcpus | v0.12.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| github.com/tursodatabase/libsql-client-go | v0.0.0-20260528064733-9d5d30a29a60 | MIT | LICENSE | f7984723ac416cb45f9eb462c4da22ad4a7d7996bd3f9c7a92288e047cce003f | - |
| github.com/twitchyliquid64/golang-asm | v0.15.1 | BSD-3-Clause | LICENSE | 2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067 | - |
| github.com/ugorji/go/codec | v1.2.12 | MIT | LICENSE | c8a84b926246b4ac76e3810722858b0f83bdea8378de49911dccbefd70b0692e | - |
| github.com/valyala/bytebufferpool | v1.0.0 | MIT | LICENSE | c4c2923938be3bf985290743398835cb6097d277663eeb1addec34b4df28d806 | - |
| github.com/valyala/fasttemplate | v1.2.2 | MIT | LICENSE | 8a314211011ad9257fa38302e8bbfe4b137a583b2b6555c61a92713b07b0b124 | - |
| github.com/vertica/vertica-sql-go | v1.3.8 | Apache-2.0 | LICENSE | 88a5d07171e46b1b28e43d70f74f192add36743e4ee652259e1ae7f3c6b43048 | - |
| github.com/vmihailenco/msgpack/v5 | v5.4.1 | BSD-2-Clause | LICENSE | 1530185dd39cdde7cb2f786a7a5fcf8bc34368b6ae73c15e72bafe88fd80b9a2 | - |
| github.com/vmihailenco/tagparser/v2 | v2.0.0 | BSD-2-Clause | LICENSE | 0f02aac22084ef463aa5f42f566feeec6aa4c99653519744a8c25cb079da5b5d | - |
| github.com/xxww0098/podhub-go | (main) | AGPL-3.0-only | LICENSE | 0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0 | - |
| github.com/yandex-cloud/go-genproto | v0.126.0 | MIT | LICENSE | 00570e62134ecae0503fcf6539bab28a975270dd8a5144be3ae5a8525568eb21 | - |
| github.com/ydb-platform/ydb-go-genproto | v0.0.0-20260810123728-f0c151ab31b9 | Apache-2.0 | LICENSE | 84785548f214a0a07183d331b9e09e0935826c20dbf5272e3fc069064ced0023 | - |
| github.com/ydb-platform/ydb-go-sdk-auth-environ | v0.5.3 | Apache-2.0 | LICENSE | 84785548f214a0a07183d331b9e09e0935826c20dbf5272e3fc069064ced0023 | - |
| github.com/ydb-platform/ydb-go-sdk/v3 | v3.155.1 | Apache-2.0 | LICENSE | 42f551dfb99fb498ad44d3e6539e59afe6c954b3ef734455823bbdc4d6324199 | - |
| github.com/ydb-platform/ydb-go-yc | v0.12.5 | Apache-2.0 | LICENSE | f316be67984c1e2192999a7f4d2c03967ad120cab9bf0ca84ab457d4d2ecfc8b | - |
| github.com/ydb-platform/ydb-go-yc-metadata | v0.6.2 | Apache-2.0 | LICENSE | f316be67984c1e2192999a7f4d2c03967ad120cab9bf0ca84ab457d4d2ecfc8b | - |
| github.com/yosssi/ace | v0.0.5 | MIT | LICENSE | ce8073dfae1749d02d3532f70f3b0bd9d9266112a494adc6619a728aefe8c066 | - |
| github.com/yuin/goldmark | v1.4.13 | MIT | LICENSE | c1d6f653c38c80294dc7994647ba0dcc508ce64a86996303c804efa2f7982bff | - |
| github.com/yusufpapurcu/wmi | v1.2.4 | MIT | LICENSE | 66e24ffb77bdafac86bd5c47ea1c3d44e2d7546ca9caa219ee66a110584864e7 | - |
| github.com/ziutek/mymysql | v1.5.4 | BSD-2-Clause | LICENSE | ab721f679db5b562add8260772f0877b3167c85b8fc03a24e1966fbb2e2407bc | - |
| go.etcd.io/bbolt | v1.3.5 | MIT | LICENSE | c15d721c37e277a11584547de6d618541501f7aa10c4e32a945a4f9ff36cb0f6 | - |
| go.opentelemetry.io/auto/sdk | v1.2.1 | Apache-2.0 | LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 | - |
| go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp | v0.72.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.opentelemetry.io/otel | v1.47.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.opentelemetry.io/otel/log | v1.47.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.opentelemetry.io/otel/metric | v1.47.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.opentelemetry.io/otel/sdk | v1.47.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.opentelemetry.io/otel/sdk/metric | v1.47.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.opentelemetry.io/otel/trace | v1.47.0 | Apache-2.0 | LICENSE | 1ae07514be1d7bb33f0698f8d91fb51b8b9fe1463157ec1c72081a49b9bc6f40 | - |
| go.shabbyrobe.org/gocovmerge | v0.0.0-20230507111327-fa4f82cfbf4d | BSD-2-Clause | LICENSE | 72e2aee5375213f43644fefbf3cf2c31969b29bf9f0121a4cccde9e917db806d | - |
| go.uber.org/goleak | v1.3.0 | MIT | LICENSE | cea390bdf643a06fbdd99fbab18c50e82c34e7bead0d55bf1168bd0d65b9fa32 | - |
| go.uber.org/multierr | v1.11.0 | MIT | LICENSE.txt | dcdabe03bef2382a130640d1c3a4cd5ec42aba1035095c38272fde694eb72405 | - |
| go.yaml.in/yaml/v3 | v3.0.5 | Apache-2.0 | LICENSE | d18f6323b71b0b768bb5e9616e36da390fbd39369a81807cca352de4e4e6aa0b | - |
| golang.org/x/arch | v0.8.0 | BSD-3-Clause | LICENSE | b73277f7730993ef8e7f80aed83e5309762fed4d77eced982abb2c00657c074d | - |
| golang.org/x/crypto | v0.58.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/exp | v0.0.0-20261011100332-faecfb24eb49 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/mod | v0.41.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/net | v0.61.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/sync | v0.24.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/sys | v0.49.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/telemetry | v0.0.0-20260924152758-ed294f943157 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/term | v0.47.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/text | v0.43.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/time | v0.14.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| golang.org/x/tools | v0.51.0 | BSD-3-Clause | LICENSE | 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad | - |
| google.golang.org/genproto/googleapis/api | v0.0.0-20261005182115-fad411399dd8 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| google.golang.org/genproto/googleapis/rpc | v0.0.0-20261005182115-fad411399dd8 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| google.golang.org/grpc | v1.84.0 | Apache-2.0 | LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 | - |
| google.golang.org/protobuf | v1.36.12 | BSD-3-Clause | LICENSE | 4835612df0098ca95f8e7d9e3bffcb02358d435dbb38057c844c99d7f725eb20 | - |
| gopkg.in/check.v1 | v1.0.0-20201130134442-10cb98267c6c | BSD-2-Clause | LICENSE | 69ce77f2b1c9c608d27f2d749b0e7d0c13960ed3b0dc07b973ac940e362e5d9c | - |
| gopkg.in/ini.v1 | v1.67.0 | Apache-2.0 | LICENSE | f6918bd93ffe07f4b2c61b8287c32cb3122e08aed0be50f1c7d0eddc87877a8f | - |
| gopkg.in/mgo.v2 | v2.0.0-20180705113604-9856a29383ce | BSD-2-Clause | LICENSE | fe60e0cc90e88f12c814adb7dc88df6791c6ec6798d8c856b7d5ad1b805b4f10 | - |
| gopkg.in/yaml.v2 | v2.2.8 | Apache-2.0 AND MIT | LICENSE, LICENSE.libyaml | b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1, a94710b55e03b5285f77d048c5ba61bb9d6ee04a06c0eb90e68821e11b0c707a | - |
| gopkg.in/yaml.v3 | v3.0.1 | Apache-2.0 | LICENSE | d18f6323b71b0b768bb5e9616e36da390fbd39369a81807cca352de4e4e6aa0b | - |
| gotest.tools/v3 | v3.5.2 | Apache-2.0 | LICENSE | 4911436829de6a543931268460c72e34bb5eb5a04c893b029f4d72c43d0b1971 | - |
| howett.net/plist | v1.0.1 | BSD-3-Clause | LICENSE | 20d9b7d9372369484ecadae229d3e3efee8029b259e11c9a1b07d2e0a3c82e39 | - |
| modernc.org/libc | v1.78.0 | BSD-3-Clause AND MIT | LICENSE, LICENSE-3RD-PARTY.md | 95ff867eb55a56935fa7492406cfa953fb7c13ca73f4c0a86ae05756b4605600, f597097efe3d97021f89170746bd3a0fb9a8b6fb26b82043ed68a4e0283bee6c | - |
| modernc.org/mathutil | v1.7.1 | BSD-3-Clause | LICENSE | bfa9bf72a72ca009fd62a8f84fca3dca67e51d93af96352723646599898b6cf5 | - |
| modernc.org/memory | v1.12.1 | BSD-3-Clause AND UNKNOWN | LICENSE, LICENSE-GO, LICENSE-LOGO, LICENSE-MMAP-GO | 59895e669f48f168b6b858358f6005779cdf40a265f7828813061b56af67b496, 2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067, 5ae5bee3072a841376451b48d8cfcec7188e10543926d5870828d36c8a750dc5, c2eba69f20d05414538c3a5df7694dde392e065ff70882e1625e90f5d6659fff | - |
| modernc.org/sqlite | v1.60.1 | BSD-3-Clause AND public-domain AND MIT | LICENSE, LICENSE-3RD-PARTY.md, LICENSE-SQLITE, LICENSE-SQLITE_VEC | c6fe05491a60ae13bcd223088d2705e36dede24e5587226231d2459ada5c4822, b4366b9c27a9364633e015011a231913ed19bf1228f335bf617e50a6f7b168a6, 8438c9c89b849131ead81d5435cb97fcf052df5b0b286dda8a2d4c29e6cb3fd0, 6ce72bbe12d975bd5286e5ab0a064c069693300c47bccbc57bec18485f1621ea | - |
| pgregory.net/rapid | v1.2.0 | MPL-2.0 | LICENSE | 66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172 | - |
