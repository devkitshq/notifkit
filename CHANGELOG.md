# Changelog

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
