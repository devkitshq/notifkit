# Changelog

## [0.1.25](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.24...notifkit-v0.1.25) (2026-11-28)


### Features

* **provider-ntfy:** add ntfy push provider ([#61](https://github.com/devkitshq/notifkit/issues/61)) ([fce3699](https://github.com/devkitshq/notifkit/commit/fce369935e918a32e6e031b361bc744a48bf6287))
* **provider-onesignal:** add onesignal push provider ([#66](https://github.com/devkitshq/notifkit/issues/66)) ([de3fe28](https://github.com/devkitshq/notifkit/commit/de3fe28cd2c08493e30b1e32463322fcdded1f28)), closes [#23](https://github.com/devkitshq/notifkit/issues/23)
* **provider-web-push:** add web push (vapid) provider ([#63](https://github.com/devkitshq/notifkit/issues/63)) ([a14ec6d](https://github.com/devkitshq/notifkit/commit/a14ec6d9767c57182fb62705c21252a0148b1efe))


### Bug Fixes

* **delivery:** send each push target only to providers that accept it ([ded378c](https://github.com/devkitshq/notifkit/commit/ded378c3bdbb5776a50810eaa1427a59693ae8c2))
* **provider-fcm:** use the template's title for the notification title ([#62](https://github.com/devkitshq/notifkit/issues/62)) ([221edf4](https://github.com/devkitshq/notifkit/commit/221edf4a1f73eaf0d77943540686d1365ba69cd2))
* **provider-ntfy:** refuse a server url with credentials, a query or a hash ([47de001](https://github.com/devkitshq/notifkit/commit/47de0017d3605ea108345803814947851e7ab2b7))
* **provider-onesignal:** trim the app id like the api key ([ca5a4b4](https://github.com/devkitshq/notifkit/commit/ca5a4b4786ce8e1f66b47a9058e45f060396e541))
* **push:** send ntfy topics and onesignal ids only to their own provider ([e16fdca](https://github.com/devkitshq/notifkit/commit/e16fdcaecb714b51529e52bb61b02f14ce5a56d5))

## [0.1.24](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.23...notifkit-v0.1.24) (2026-11-25)


### Features

* **provider-vonage:** add vonage sms provider ([#60](https://github.com/devkitshq/notifkit/issues/60)) ([7b2700b](https://github.com/devkitshq/notifkit/commit/7b2700b9564ddcd6aff7bc7863f56506903a5d4d)), closes [#20](https://github.com/devkitshq/notifkit/issues/20)
* **templates:** support dotted paths and spaces in placeholders ([#51](https://github.com/devkitshq/notifkit/issues/51)) ([efdfa5e](https://github.com/devkitshq/notifkit/commit/efdfa5efd3c03ace46dc4c31ab854cbc0142eb34)), closes [#11](https://github.com/devkitshq/notifkit/issues/11)


### Bug Fixes

* **api:** require auth on paths with doubled slashes ([002cf04](https://github.com/devkitshq/notifkit/commit/002cf04510c09dd704cf6668286eccc328b9faa1))
* **contracts:** reject sms and whatsapp contacts that aren't E.164 ([d76d5e0](https://github.com/devkitshq/notifkit/commit/d76d5e02f0b0ef4544613d7e3a22f9d31de83334))
* **dashboard:** redirect trailing-slash admin URLs ([f4d50b4](https://github.com/devkitshq/notifkit/commit/f4d50b47bb6a0686e2f929e2210ffba58f087a79))
* **delivery:** deactivate non-push contacts the last provider calls invalid ([3e9940d](https://github.com/devkitshq/notifkit/commit/3e9940d6780cbf947a44d252cbb9d90ee80d1167))
* match the renderer's placeholders in mcp previews and ai prompts ([#59](https://github.com/devkitshq/notifkit/issues/59)) ([2a5f385](https://github.com/devkitshq/notifkit/commit/2a5f3851cec6069ea7580d07535a70148835e2fb))
* **provider-vonage,provider-whatsapp:** cancel the request when delivery aborts the send ([aea574e](https://github.com/devkitshq/notifkit/commit/aea574ed6eaaa972c64ff44523320bb667cb55b1))
* **provider-vonage,provider-whatsapp:** refuse destinations that aren't a phone number ([cc585cc](https://github.com/devkitshq/notifkit/commit/cc585ccc0f47b9e62c393c2bbb34a5893ae831b5))

## [0.1.23](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.22...notifkit-v0.1.23) (2026-11-22)


### Bug Fixes

* **api:** reject unknown key roles and mount every provider's webhook ([4ff2713](https://github.com/devkitshq/notifkit/commit/4ff2713564601cbe4b4262061e80ee0bb917c0e7))
* **api:** stop accepting a deleted project's API keys right away ([d306e10](https://github.com/devkitshq/notifkit/commit/d306e10ed722b71757bb8f5ac0df34aa5de29be5))
* **dashboard:** show a traced workflow run's name and steps reached ([ebbf8db](https://github.com/devkitshq/notifkit/commit/ebbf8dbd337c0d2c2e1d7c16c5e9570952f0c915))
* drop cached users and contacts when they change ([4137536](https://github.com/devkitshq/notifkit/commit/4137536c7be207d612c5f4c1ced8c01a311c8b91))
* **events:** keep a workflow's waiter until its resume is published ([1b6b03f](https://github.com/devkitshq/notifkit/commit/1b6b03fc1fc0a03f81cf70c24d603a6268eaa303))
* fail AI sends with no model and drop edited templates in enricher ([49a27c9](https://github.com/devkitshq/notifkit/commit/49a27c9bc901ae9aa466c356e84d1278b7fa5c66))
* **mcp:** keep a waitForEvent step's match when creating a workflow ([281fa8a](https://github.com/devkitshq/notifkit/commit/281fa8abd98f1f1aace901da1de79f432efe7a7e))
* **providers:** stop timed-out sends landing twice, keep fcm apps apart ([141f11c](https://github.com/devkitshq/notifkit/commit/141f11c4edc6c108d4611b98d81e9b972d0b6f5c))

## [0.1.22](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.21...notifkit-v0.1.22) (2026-11-21)


### Features

* **provider-ses:** read bounces and complaints from SNS ([#43](https://github.com/devkitshq/notifkit/issues/43)) ([c44e2a0](https://github.com/devkitshq/notifkit/commit/c44e2a0c587b92c8f76698d8f682c25699b00a6d))


### Bug Fixes

* **delivery:** stop a burst over a provider's rate limit from failing ([#44](https://github.com/devkitshq/notifkit/issues/44)) ([9bf61ad](https://github.com/devkitshq/notifkit/commit/9bf61ad89346344d6a1263893995c157b75cfe67)), closes [#36](https://github.com/devkitshq/notifkit/issues/36)

## [0.1.21](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.20...notifkit-v0.1.21) (2026-11-20)


### Features

* **provider-ses:** add an AWS SES email transport ([#31](https://github.com/devkitshq/notifkit/issues/31)) ([202afe5](https://github.com/devkitshq/notifkit/commit/202afe53fd00b4ce1dc51b53342d0da4b38ff339))


### Bug Fixes

* **delivery:** log provider rate-limit hits at debug, not warn ([4b8e703](https://github.com/devkitshq/notifkit/commit/4b8e703681c839f53476496654ef3f1afd25d60f))
* **delivery:** spread retries so a failed burst doesn't retry at once ([65bf1af](https://github.com/devkitshq/notifkit/commit/65bf1af7eabc7900b4bce1184ca9f4b5f269ea22))

## [0.1.20](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.19...notifkit-v0.1.20) (2026-11-18)


### Features

* close providers when the server stops ([5cc8bb5](https://github.com/devkitshq/notifkit/commit/5cc8bb5aeb94de99ef101764ba399a9180cb943c))
* **create-notifkit:** scaffold an app with several providers ([2aa20d7](https://github.com/devkitshq/notifkit/commit/2aa20d7ad93bdbfa796a750cb7ae0b721c13ec1f))
* **provider-smtp:** add an SMTP email transport built on nodemailer ([#29](https://github.com/devkitshq/notifkit/issues/29)) ([9e15928](https://github.com/devkitshq/notifkit/commit/9e159283cbca0c6e7d11bd31d83cbeb7c0ecabd8))


### Bug Fixes

* **contracts:** reject email contacts that aren't one plain address ([506e085](https://github.com/devkitshq/notifkit/commit/506e085625303530bd07a237670d70a53c7f1df4))
* **provider-smtp:** give up on a stalled server within delivery's send timeout ([e49f5e6](https://github.com/devkitshq/notifkit/commit/e49f5e647cd8b8952a2ae854315576917a8d8ad7))

## [0.1.19](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.18...notifkit-v0.1.19) (2026-11-17)


### Bug Fixes

* **contracts:** reject non-IANA user timezones ([#27](https://github.com/devkitshq/notifkit/issues/27)) ([235e20a](https://github.com/devkitshq/notifkit/commit/235e20a0dbb9d63e0d2dc742a32fc81518502b4e)), closes [#26](https://github.com/devkitshq/notifkit/issues/26)

## [0.1.18](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.17...notifkit-v0.1.18) (2026-11-05)


### Features

* **scheduler:** delete delivery logs older than LOG_RETENTION_DAYS ([a6ab165](https://github.com/devkitshq/notifkit/commit/a6ab1654954b3bbfe157e1a14577d5816d9e4086))


### Bug Fixes

* **api:** fail notify when the inline user cannot be saved ([099f5ed](https://github.com/devkitshq/notifkit/commit/099f5edd117f042eafeee8870485cb3958bfba9b))
* **api:** let read-only sessions log out ([386c132](https://github.com/devkitshq/notifkit/commit/386c13234d71d9004396d3ce2b66c6f4aa4b7564))
* **config:** validate RATE_LIMIT_PER_HOUR with the rest of the config ([cea8025](https://github.com/devkitshq/notifkit/commit/cea8025c0c6caf577805a0e862e4784770d69495))
* **engine:** keep the lease short for scheduled sends ([66b57d0](https://github.com/devkitshq/notifkit/commit/66b57d09c5dbfb378e5306e4ff551319d15760c4))
* **scheduler:** keep delivery logs unless LOG_RETENTION_DAYS is set ([bab14cd](https://github.com/devkitshq/notifkit/commit/bab14cdb79681a5c8d8bc5b1a1045de01f5fa1cd))
* **workflow:** only reap instances that are still running ([276d7aa](https://github.com/devkitshq/notifkit/commit/276d7aa5594383f22ae4af55cf6fd0e133676ae4))

## [0.1.17](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.16...notifkit-v0.1.17) (2026-11-01)


### Features

* **config:** raise the SEGMENT_MAX_USERS default to 100,000 ([58952a3](https://github.com/devkitshq/notifkit/commit/58952a3d56e626ce6ce03e59ba9619208a4487d7))


### Bug Fixes

* **workers:** hold a message's lease while its handler runs ([19c3f56](https://github.com/devkitshq/notifkit/commit/19c3f564e9097baf0cc18dcd8ba087ee7d9ea54d))

## [0.1.16](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.15...notifkit-v0.1.16) (2026-11-01)


### Bug Fixes

* **ai:** redact the Redis password in the startup log ([543af78](https://github.com/devkitshq/notifkit/commit/543af787a98829f5a7d26d4e554589c5245ecd99))
* **api:** answer malformed JSON on DLQ replay with malformed_json ([0e28713](https://github.com/devkitshq/notifkit/commit/0e28713acfdeee03ffb3b4daad97a70e84e1a266))
* **api:** keep a revoked API key from outliving revocation past 2,000 keys ([f541b7f](https://github.com/devkitshq/notifkit/commit/f541b7f930cbcec053caa600f0ee7f07485d6898))
* **contracts:** accept non-UUID template ids on delivered and failed events ([c129b1c](https://github.com/devkitshq/notifkit/commit/c129b1c6c4d360c7a75766e68ab204af428c9390))
* **contracts:** quiet-hours validation message no longer says UTC ([8d759a6](https://github.com/devkitshq/notifkit/commit/8d759a6e33e0897a4438cc875cdec788596bdea6))
* **dashboard:** drop the Templates 'Last Updated' column the API never fills ([c4791bd](https://github.com/devkitshq/notifkit/commit/c4791bd28545883fba1313acea02f592ff8bafac))
* **dashboard:** encode template, DLQ and task ids in request URLs ([79ffa25](https://github.com/devkitshq/notifkit/commit/79ffa25ea7dcd42daebee1108b282097305ed4ca))
* **dashboard:** send the live feed's session token in a header, not the URL ([ecbedec](https://github.com/devkitshq/notifkit/commit/ecbedecc06a2dbe7bba090ffac3f033eabf2c41c))
* **delivery:** log idempotency lock release failures instead of swallowing them ([8eb3152](https://github.com/devkitshq/notifkit/commit/8eb3152a3af6429b99c32fba3910f072c0534f49))
* **engine:** warn about a missing UNSUBSCRIBE_SECRET once at startup ([7f2cff1](https://github.com/devkitshq/notifkit/commit/7f2cff1e4f9708baa5777e7f4b98198bd774b56f))
* **events:** log the flush error with its stack ([82781f4](https://github.com/devkitshq/notifkit/commit/82781f4dce8dad0506459d0c474b422de9f61408))
* **examples:** send x-project-id with the admin key and default workflows to port 3000 ([19035af](https://github.com/devkitshq/notifkit/commit/19035af17dae6144f37bb68b5412004779c77552))
* **mcp:** correct channel default, log status and contact channel descriptions ([d65ac2f](https://github.com/devkitshq/notifkit/commit/d65ac2f82dc42dd7fb7fe318e2a1b00821087f72))
* **mcp:** describe quiet hours in the user's timezone, not UTC ([f5820f7](https://github.com/devkitshq/notifkit/commit/f5820f79042194367788a3ff19d1ccefeb8048f1))
* **scripts:** describe the 401 and 403 create-project actually gets ([d1044e8](https://github.com/devkitshq/notifkit/commit/d1044e8fde6b204d899d1f55dfbd61943c93cc27))
* **workers:** clear the stop timeout once the worker has stopped ([7bf09cb](https://github.com/devkitshq/notifkit/commit/7bf09cbd60ccbc1df5ede09599219e44d6a8ab3b))
* **workflows:** carry a notify step's campaign into the requested event ([3411e18](https://github.com/devkitshq/notifkit/commit/3411e1859755bd4945bce36ac110961a81fc3ddb))

## [0.1.15](https://github.com/devkitshq/notifkit/compare/notifkit-v0.1.14...notifkit-v0.1.15) (2026-10-31)


### Bug Fixes

* **engine:** don't release quiet hours early during a DST fall-back hour ([42edf75](https://github.com/devkitshq/notifkit/commit/42edf750a96f71bb0f04a7f3aef77ceed8fcd9ad))
