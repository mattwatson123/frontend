// Be wary of renaming this file; some titles, like 'dfp.js',
// can trigger adblocker rules, and make the module fail to load in dev.

define([
    'bean',
    'bonzo',
    'qwery',
    'Promise',
    'raven',
    'common/utils/$',
    'common/utils/$css',
    'common/utils/config',
    'common/utils/cookies',
    'common/utils/detect',
    'common/utils/fastdom-promise',
    'common/utils/mediator',
    'common/utils/report-error',
    'common/utils/sha1',
    'common/utils/url',
    'common/utils/user-timing',
    'common/modules/commercial/ads/sticky-mpu',
    'common/modules/commercial/build-page-targeting',
    'common/modules/commercial/commercial-features',
    'common/modules/commercial/dfp/ophan-tracking',
    'common/modules/commercial/dfp/breakout-iframe',
    'common/modules/commercial/dfp/PrebidService',
    'common/modules/commercial/dfp/track-ad-load',
    'common/modules/onward/geo-most-popular',
    'common/modules/experiments/ab',
    'common/modules/analytics/beacon',
    'common/modules/identity/api',
    'common/views/svgs',
    'lodash/functions/once',
    'lodash/objects/forOwn',
    'lodash/functions/debounce',
    'lodash/collections/contains',
    'lodash/arrays/uniq',
    'lodash/arrays/flatten',
    'lodash/collections/every',
    'lodash/collections/map',
    'lodash/collections/filter',
    'common/utils/chain',
    'lodash/collections/find',
    'lodash/arrays/last',
    'lodash/arrays/intersection',
    'lodash/arrays/initial'
], function (
    bean,
    bonzo,
    qwery,
    Promise,
    raven,
    $,
    $css,
    config,
    cookies,
    detect,
    fastdom,
    mediator,
    reportError,
    sha1,
    urlUtils,
    userTiming,
    stickyMpu,
    buildPageTargeting,
    commercialFeatures,
    ophanTracking,
    breakoutIFrame,
    PrebidService,
    trackAdLoad,
    geoMostPopular,
    ab,
    beacon,
    id,
    svgs,
    once,
    forOwn,
    debounce,
    contains,
    uniq,
    flatten,
    every,
    map,
    filter,
    chain,
    find,
    last,
    intersection,
    initial
) {
    /**
     * Right, so an explanation as to how this works...
     *
     * Create a new ad slot using the following code:
     *
     * <div class="js-ad-slot AD_SLOT_CLASS" data-name="AD_SLOT_NAME" data-mobile="300,50|320,50"
     *      data-desktop="300,250" data-refresh="false" data-label="false">
     *     <div id="SLOT_ID" class="ad-container"></div>
     * </div>
     *
     * You can set the set which size ad(s) should be loaded at which breakpoint by using the
     * data attribute. The available breakpoints and their sizes are listed in the config below.
     * You do not need to specify all of these. If you set a mobile size, then that size will be used
     * for all ads in that slot until another breakpoint is detected, in the above case, that's desktop.
     *
     * Labels are automatically prepended to an ad that was successfully loaded.
     *
     */
    /**
     * Private variables
     */
    var dfp;
    var adSlotSelector = '.js-ad-slot';
    var displayed = false;
    var rendered = false;
    var adverts = {};
    var creativeIDs = [];
    var prebidService = null;
    var googletag;

    var renderStartTime = null;
    var prebidEnabled = config.switches.headerBiddingUs && config.page.edition === 'US';

    /**
     * INIT
     * - Set up dependencies, targeting, and response listeners
     */

    function init() {
        return commercialFeatures.dfpAdvertising ?
            setupAdvertising() :
            fastdom.write(function () {
                $(adSlotSelector).remove();
            });
    }

    function setupAdvertising() {
        return new Promise(function (resolve) {
            // if we don't already have googletag, create command queue and load it async
            if (!window.googletag) {
                window.googletag = googletag = { cmd: [] };
                // load the library asynchronously
                require(['js!googletag.js']);
            } else {
                googletag = window.googletag;
            }

            if (prebidEnabled) {
                prebidService = new PrebidService();
            }

            googletag.cmd.push = raven.wrap({ deep: true }, googletag.cmd.push);

            googletag.cmd.push(
                function () {
                    renderStartTime = new Date().getTime();
                },
                setListeners,
                setPageTargeting
            );

            resolve();
        });
    }

    function setListeners() {
        ophanTracking.trackPerformance(googletag, renderStartTime);

        var recordFirstAdRendered = once(function () {
            beacon.beaconCounts('ad-render');
        });

        googletag.pubads().addEventListener('slotRenderEnded', raven.wrap(function (event) {
            rendered = true;
            recordFirstAdRendered();
            parseAd(event).then(function (adSlotId) {
                mediator.emit('modules:commercial:dfp:rendered', event);
                allAdsRendered(adSlotId);
            });
        }));
    }

    function setPageTargeting() {
        forOwn(buildPageTargeting(), function (value, key) {
            googletag.pubads().setTargeting(key, value);
        });
    }

    /**
     * LOAD ADS
     * - Define existing adslots and load adverts
     */
    var lazyLoadEnabled = false;

    function load() {
        return commercialFeatures.dfpAdvertising ? loadAdvertising() : Promise.resolve();
    }

    function loadAdvertising() {
        googletag.cmd.push(
            defineAdverts,
            setPublisherProvidedId,
            shouldLazyLoad() ? displayLazyAds : displayAds,
            // anything we want to happen after displaying ads
            refreshOnResize
        );

        // show sponsorship placeholder if adblock detected
        showSponsorshipPlaceholder();
    }

    /**
     * Loop through each slot detected on the page and define it based on the data
     * attributes on the element.
     */
    function defineAdverts() {
        // Get all ad slots
        qwery(adSlotSelector)
            // convert them to bonzo objects
            .map(bonzo)
            // remove the ones which should not be there
            .filter(function ($adSlot) {
                // filter out (and remove) hidden ads
                if (shouldFilterAdSlot($adSlot)) {
                    fastdom.write(function () {
                        $adSlot.remove();
                    });
                    return false;
                } else {
                    return true;
                }
            })
            // convert to Advert ADT
            .map(function ($adSlot) {
                return new Advert($adSlot);
            })
            // fill in the adverts map
            .forEach(function (advert) {
                adverts[advert.adSlotId] = advert;
            });
    }

    function shouldFilterAdSlot($adSlot) {
        return isVisuallyHidden() || isDisabledCommercialFeature();

        function isVisuallyHidden() {
            return $css($adSlot, 'display') === 'none';
        }

        function isDisabledCommercialFeature() {
            return !commercialFeatures.topBannerAd && $adSlot.data('name') === 'top-above-nav';
        }
    }

    function setPublisherProvidedId() {
        var user = id.getUserFromCookie();
        if (user) {
            var hashedId = sha1.hash(user.id);
            googletag.pubads().setPublisherProvidedId(hashedId);
        }
    }

    function shouldLazyLoad() {
        // We do not want lazy loading on pageskins because it messes up the roadblock
        return !(config.page.hasPageSkin);
    }

    function showSponsorshipPlaceholder() {
        var sponsorshipIdsFound = isSponsorshipContainerTest();

        if (detect.adblockInUseSync() && sponsorshipIdsFound.length) {
            fastdom.write(function () {
                sponsorshipIdsFound.forEach(function (value) {
                    var sponsorshipIdFoundEl = $(value);
                    var sponsorshipIdClasses = sponsorshipIdFoundEl.attr('class').replace('ad-slot ', '');
                    var sponsorshipBadge = '<div class="' + sponsorshipIdClasses + '">' + sponsorshipIdFoundEl.html() + '</div>';

                    if (sponsorshipIdFoundEl.previous().length) {
                        sponsorshipIdFoundEl.previous().append(sponsorshipBadge);
                    } else {
                        sponsorshipIdFoundEl.parent().prepend(sponsorshipBadge);
                    }
                });
            });
        }
    }

    function isSponsorshipContainerTest() {
        var sponsorshipIds = ['#dfp-ad--adbadge', '#dfp-ad--spbadge', '#dfp-ad--fobadge', '#dfp-ad--adbadge1', '#dfp-ad--spbadge1', '#dfp-ad--fobadge1', '#dfp-ad--adbadge2', '#dfp-ad--spbadge2', '#dfp-ad--fobadge2', '#dfp-ad--adbadge3', '#dfp-ad--spbadge3', '#dfp-ad--fobadge3', '#dfp-ad--adbadge4', '#dfp-ad--spbadge4', '#dfp-ad--fobadge4', '#dfp-ad--adbadge5', '#dfp-ad--spbadge5', '#dfp-ad--fobadge5'];
        var sponsorshipIdsReturned = [];

        sponsorshipIds.forEach(function (value) {
            if ($(value).length) {
                sponsorshipIdsReturned.push(value);
            }
        });
        return sponsorshipIdsReturned;
    }

    /**
     * LOAD ADS: LAZY PATH
     */

    function displayLazyAds() {
        googletag.pubads().collapseEmptyDivs();
        googletag.enableServices();
        instantLoad();
        enableLazyLoad();
    }

    function instantLoad() {
        getAdvertArray().forEach(function (advert) {
            if (contains(['dfp-ad--pageskin-inread', 'dfp-ad--merchandising-high', 'dfp-ad--im'], advert.adSlotId)) {
                loadSlot(advert);
            }
        });
    }

    function enableLazyLoad() {
        if (!lazyLoadEnabled) {
            lazyLoadEnabled = true;
            mediator.on('window:throttledScroll', lazyLoad);
            lazyLoad();
        }
    }

    function lazyLoad() {
        if (adverts.length === 0) {
            disableLazyLoad();
        } else {
            var scrollTop = window.pageYOffset;
            var viewportHeight = bonzo.viewport().height;
            var scrollBottom = scrollTop + viewportHeight;
            var depth = 0.5;

            var advertsToLoad = getAdvertArray().filter(function (advert) {
                return !advert.isRendered
                    && !advert.isLoading
                        // if the position of the ad is above the viewport - offset (half screen size)
                    && (scrollBottom > document.getElementById(advert.adSlotId).getBoundingClientRect().top + scrollTop - viewportHeight * depth);
            });
            advertsToLoad.forEach(loadSlot);
        }
    }

    function disableLazyLoad() {
        lazyLoadEnabled = false;
        mediator.off('window:throttledScroll', lazyLoad);
    }

    /**
     * LOAD ADS: NON-LAZY PATH
     */

    function displayAds() {
        googletag.pubads().enableSingleRequest();
        googletag.pubads().collapseEmptyDivs();
        googletag.enableServices();
        // as this is an single request call, only need to make a single display call (to the first ad
        // slot)
        var firstAd = getAdvertArray()[0];
        loadSlot(firstAd);
    }

    /**
     * ADD SLOT
     */

    function addSlot(adSlot) {
        var $adSlot = bonzo(adSlot);
        var slotId = $adSlot.attr('id');

        function displayAd ($adSlot) {
            var advert = new Advert($adSlot);
            adverts[slotId] = advert;
            if (shouldLazyLoad()) {
                enableLazyLoad();
            } else {
                loadSlot(advert);
            }
        }

        if (displayed && !adverts[slotId]) { // dynamically add ad slot
            // this is horrible, but if we do this before the initial ads have loaded things go awry
            if (rendered) {
                displayAd($adSlot);
            } else {
                mediator.once('modules:commercial:dfp:rendered', function () {
                    displayAd($adSlot);
                });
            }
        }
    }

    function loadSlot(advert) {
        advert.isLoading = true;

        if (shouldPrebidAdvert(advert)) {
            prebidService.loadAdvert(advert).then(function onDisplay() {
                displayed = true;
            });
        } else {
            googletag.display(advert.adSlotId);
            displayed = true;
        }
    }

    function shouldPrebidAdvert(advert) {
        var excludedSlotIds = [
            'dfp-ad--pageskin-inread',
            'dfp-ad--merchandising-high'
        ];
        return prebidEnabled && shouldLazyLoad() && !contains(excludedSlotIds, advert.adSlotId);
    }

    /**
     * REFRESH ON WINDOW RESIZE
     */

    var slotsToRefresh = [];
    var hasBreakpointChanged = detect.hasCrossedBreakpoint(true);

    var resizeTimeout = 2000;
    var windowResize = debounce(
        function () {
            // refresh on resize
            hasBreakpointChanged(refresh);
        }, resizeTimeout
    );

    function refreshOnResize() {
        mediator.on('window:resize', windowResize);
    }

    function refresh(breakpoint, previousBreakpoint) {
        googletag.pubads().refresh(
            chain(slotsToRefresh)
            // only refresh if the slot needs to
                .and(filter, function (slotInfo) {
                    return shouldSlotRefresh(slotInfo, breakpoint, previousBreakpoint);
                }).and(map, function (slotInfo) {
                return slotInfo.slot;
            }).valueOf()
        );
    }

    function shouldSlotRefresh(slotInfo, breakpoint, previousBreakpoint) {
        // get the slots breakpoints
        var slotBreakpoints = chain(detect.breakpoints).and(filter, function (breakpointInfo) {
                return slotInfo.$adSlot.data(breakpointNameToAttribute(breakpointInfo.name));
            }).valueOf(),
        // have we changed breakpoints
            slotBreakpoint = getSlotsBreakpoint(breakpoint, slotBreakpoints);
        return slotBreakpoint &&
            getSlotsBreakpoint(previousBreakpoint, slotBreakpoints) !== slotBreakpoint;
    }

    function getSlotsBreakpoint(breakpoint, slotBreakpoints) {
        return chain(detect.breakpoints).and(initial, function (breakpointInfo) {
            return breakpointInfo.name !== breakpoint;
        }).and(intersection, slotBreakpoints).and(last).value();
    }

    /**
     * PARSE RETURNED ADVERTS
     */

    var callbacks = {
        '0,0': isFluid250('ad-slot--top-banner-ad'),
        '300,251': function (event, $adSlot) {
            stickyMpu($adSlot);
        },
        '300,250': function (event, $adSlot) {
            if ($adSlot.hasClass('ad-slot--right')) {
                var mobileAdSizes = $adSlot.attr('data-mobile');
                if (mobileAdSizes && mobileAdSizes.indexOf('300,251') > -1) {
                    stickyMpu($adSlot);
                }
            }
        },
        '1,1': function (event, $adSlot) {
            if (!event.slot.getOutOfPage()) {
                $adSlot.addClass('u-h');
                var $parent = $adSlot.parent();
                // if in a slice, add the 'no mpu' class
                if ($parent.hasClass('js-fc-slice-mpu-candidate')) {
                    $parent.addClass('fc-slice__item--no-mpu');
                }
            }
        },
        '300,1050': function () {
            // remove geo most popular
            geoMostPopular.whenRendered.then(function (geoMostPopular) {
                fastdom.write(function () {
                    bonzo(geoMostPopular.elem).remove();
                });
            });
        },
        '88,70': isFluid250('ad-slot--top-banner-ad'),
        '88,71': isFluid('ad-slot--mobile'),
        '88,88': isFluid250('ad-slot--commercial-component')
    };

    function isFluid250(className) {
        return function (_, $adSlot) {
            if ($adSlot.hasClass(className)) {
                fastdom.write(function () {
                    $adSlot.addClass('ad-slot__fluid250');
                });
            }
        };
    }

    function isFluid(className) {
        return function (_, $adSlot) {
            if ($adSlot.hasClass(className)) {
                fastdom.write(function () {
                    $adSlot.addClass('ad-slot--fluid');
                });
            }
        };
    }

    function parseAd(event) {
        var size;
        var adSlotId = event.slot.getSlotElementId();
        var $adSlot;
        var $placeholder;
        var $adSlotContent;

        if (event.isEmpty) {
            removeSlot(adSlotId);

            // This empty slot could be caused by a targeting problem,
            // let's report these and diagnose the problem in sentry.
            // Keep the sample rate low, otherwise we'll get rate-limited (report-error will also sample down)
            if (config.switches.reportEmptyDfpResponses && Math.random() < 0.001) {
                var adUnitPath = event.slot.getAdUnitPath();
                var adTargetingMap = event.slot.getTargetingMap();
                var adTargetingKValues = adTargetingMap ? adTargetingMap['k'] : [];
                var adKeywords = adTargetingKValues ? adTargetingKValues.join(', ') : '';

                reportError(new Error('dfp returned an empty ad response'), {
                    feature: 'commercial',
                    adUnit: adUnitPath,
                    adSlot: adSlotId,
                    adKeywords: adKeywords
                }, false);
            }

            return Promise.resolve(adSlotId);
        } else {
            $adSlot = $('#' + adSlotId);

            // Store ads IDs for technical feedback
            creativeIDs.push(event.creativeId);

            // remove any placeholder ad content
            $placeholder = $('.ad-slot__content--placeholder', $adSlot);
            $adSlotContent = $('div', $adSlot);
            fastdom.write(function () {
                $placeholder.remove();
                $adSlotContent.addClass('ad-slot__content');
            });

            // Check if creative is a new gu style creative and place labels accordingly.
            // Use public method so that tests can stub it out.
            return dfp.checkForBreakout($adSlot).then(function () {
                addLabel($adSlot);

                size = event.size.join(',');
                // is there a callback for this size
                if (callbacks[size]) {
                    callbacks[size](event, $adSlot);
                }

                if ($adSlot.hasClass('ad-slot--container-inline') && $adSlot.hasClass('ad-slot--not-mobile')) {
                    fastdom.write(function () {
                        $adSlot.parent().css('display', 'flex');
                    });
                }

                return adSlotId;
            }).catch(raven.captureException);
        }
    }

    function removeSlot(adSlotId) {
        delete adverts[adSlotId];
        fastdom.write(function () {
            $('#' + adSlotId).remove();
        });
    }

    /**
     * Checks the contents of the ad for special breakout classes.
     *
     * If one of these classes is detected, then the contents of that iframe is retrieved
     * and written onto the parent page.
     *
     * Currently this is being used for sponsored logos and commercial components so they
     * can inherit fonts.
     */
    function checkForBreakout($adSlot) {
        return new Promise(function (resolve, reject) {
            // DFP sometimes sends back two iframes, one with actual ad and one with 0,0 sizes and __hidden__ 'paramter'
            // The later one will never go to 'complete' state on IE so lets avoid it.
            var iFrame = find($('iframe', $adSlot), function (iframe) { return iframe.id.match('__hidden__') === null; });

            // No iFrame, no work to do
            if (typeof iFrame === 'undefined') {
                reject();
            }
            // IE needs the iFrame to have loaded before we can interact with it
            else if (iFrame.readyState && iFrame.readyState !== 'complete') {
                bean.on(iFrame, 'readystatechange', function (e) {
                    var updatedIFrame = e.srcElement;

                    if (
                        /*eslint-disable valid-typeof*/
                    updatedIFrame &&
                    typeof updatedIFrame.readyState !== 'unknown' &&
                    updatedIFrame.readyState === 'complete'
                    /*eslint-enable valid-typeof*/
                    ) {
                        bean.off(updatedIFrame, 'readystatechange');
                        resolve(breakoutIFrame(updatedIFrame, $adSlot));
                    }
                });
            } else {
                resolve(breakoutIFrame(iFrame, $adSlot));
            }
        });
    }

    function addLabel($adSlot) {
        fastdom.write(function () {
            if (shouldRenderLabel($adSlot)) {
                $adSlot.prepend('<div class="ad-slot__label" data-test-id="ad-slot-label">Advertisement</div>');
            }
        });
    }

    function shouldRenderLabel($adSlot) {
        return !$adSlot.hasClass('ad-slot--frame') &&
            !$adSlot.hasClass('gu-style') &&
            ($adSlot.data('label') !== false && qwery('.ad-slot__label', $adSlot[0]).length === 0);
    }

    function allAdsRendered(adSlotId) {
        if (adverts[adSlotId] && !adverts[adSlotId].isRendered) {
            adverts[adSlotId].isLoading = false;
            adverts[adSlotId].isRendered = true;
        }

        if (every(adverts, 'isRendered')) {
            userTiming.mark('All ads are rendered');
            mediator.emit('modules:commercial:dfp:alladsrendered');
        }
    }

    /**
     * USER FEEDBACK
     */

    function getCreativeIDs() {
        return creativeIDs;
    }

    /**
     * ADVERT DOMAIN OBJECTS
     */

    function getAdverts() {
        return adverts;
    }

    function getAdvertArray() {
        return Object.keys(adverts).map(function (key) {
            return adverts[key];
        });
    }

    function Advert($adSlot) {
        this.isRendered = false;
        this.isLoading = false;
        this.adSlotId = $adSlot.attr('id');
        this.sizes = getAdBreakpointSizes($adSlot);
        this.slot = defineSlot($adSlot, this.sizes);
    }

    function getAdBreakpointSizes($adSlot) {
        var sizes = {};
        detect.breakpoints.forEach(function (breakpoint) {
            var data = $adSlot.data(breakpointNameToAttribute(breakpoint.name));
            if (data) {
                sizes[breakpoint.name] = createSizeMapping(data);
            }
        });
        return sizes;
    }

    function breakpointNameToAttribute(breakpointName) {
        return breakpointName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    }

    /** A breakpoint can have various sizes assigned to it. You can assign either on
     * set of sizes or multiple.
     *
     * One size       - `data-mobile="300,50"`
     * Multiple sizes - `data-mobile="300,50|320,50"`
     */
    function createSizeMapping(attr) {
        return attr.split('|').map(function (size) {
            return size === 'fluid' ? 'fluid' : size.split(',').map(Number);
        });
    }

    function defineSlot($adSlot, sizes) {
        var slotTarget = $adSlot.data('slot-target') || $adSlot.data('name');
        var adUnitOverride = urlUtils.getUrlVars()['ad-unit'];
        // if ?ad-unit=x, use that
        var adUnit = adUnitOverride ?
            ['/', config.page.dfpAccountId, '/', adUnitOverride].join('')
            : config.page.adUnit;
        var id             = $adSlot.attr('id');
        var slot;
        var size;
        var sizeMapping;

        if ($adSlot.data('out-of-page')) {
            slot = googletag.defineOutOfPageSlot(adUnit, id);
        } else {
            sizeMapping = buildSizeMapping(sizes);
            // as we're using sizeMapping, pull out all the ad sizes, as an array of arrays
            size = uniq(
                flatten(sizeMapping, true, function (map) { return map[1]; }),
                function (size) { return size[0] + '-' + size[1]; }
            );
            slot = googletag.defineSlot(adUnit, size, id).defineSizeMapping(sizeMapping);
        }

        if ($adSlot.data('series')) {
            slot.setTargeting('se', parseKeywords($adSlot.data('series')));
        }

        if ($adSlot.data('keywords')) {
            slot.setTargeting('k', parseKeywords($adSlot.data('keywords')));
        }

        slot.addService(googletag.pubads())
            .setTargeting('slot', slotTarget);

        // Add to the array of ads to be refreshed (when the breakpoint changes)
        // only if it's `data-refresh` attribute isn't set to false.
        if ($adSlot.data('refresh') !== false) {
            slotsToRefresh.push({
                $adSlot: $adSlot,
                slot: slot
            });
        }

        return slot;
    }

    /**
     * Builds and assigns the correct size map for a slot based on the breakpoints
     * attached to the element via data attributes.
     *
     * A new size map is created for a given slot. We then loop through each breakpoint
     * defined in the config, checking if that breakpoint has been set on the slot.
     *
     * If it has been defined, then we add that size to the size mapping.
     *
     */
    function buildSizeMapping(sizes) {
        var mapping = googletag.sizeMapping();

        detect.breakpoints.forEach(function (breakpoint) {
            var sizesForBreakpoint = sizes[breakpoint.name];
            if (sizesForBreakpoint) {
                mapping.addSize([breakpoint.width, 0], sizesForBreakpoint);
            }
        });

        return mapping.build();
    }

    function parseKeywords(keywords) {
        return map((keywords || '').split(','), function (keyword) {
            return keyword.split('/').pop();
        });
    }

    /**
     * Module
     */

    dfp = {
        init:           init,
        loadAds:        load,
        addSlot:        addSlot,
        getCreativeIDs: getCreativeIDs,
        trackAdLoad:    trackAdLoad,

        // Used privately but exposed only for unit testing
        getAdverts:     getAdverts,
        shouldLazyLoad: shouldLazyLoad,
        checkForBreakout: checkForBreakout,

        // testing
        reset: function () {
            displayed = false;
            rendered = false;
            adverts = {};
            slotsToRefresh = [];
            mediator.off('window:resize', windowResize);
            hasBreakpointChanged = detect.hasCrossedBreakpoint(true);
        }
    };

    return dfp;

});
