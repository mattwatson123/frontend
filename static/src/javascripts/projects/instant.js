/*global document, Turbolinks, Promise*/

document.addEventListener('turbolinks:before-cache', function() {
  //debugger;
  console.log('turbolinks:before-cache');
});
document.addEventListener('turbolinks:render', function() {
  //debugger;
  console.log('turbolinks:render');
});
document.addEventListener('turbolinks:click', function() {
  //debugger;
  console.log('turbolinks:click');
});


// Cache first page load
Turbolinks.controller.cacheSnapshot();

// can use data-turbolinks-action="restore" to restore page instead of preview.

// TODO move cache to indexdb

// fetch other urls and put into Turbolinks cache
function store( location ) {
  return fetchUrl( location )
    .then(function( responseText ) {
      if ( !Turbolinks.controller.cache.has( location ) ) {
        var snapshot = Turbolinks.Snapshot.fromHTML( responseText );
        Turbolinks.controller.cache.put( location, snapshot );
      }
    });
}

var current = {};
function fetchUrl( url ) {
  if ( !current[ url ] ) {
    current[ url ] = fetch( url )
      .then(function( response ) {
        return response.text();
      });
  }
  return new Promise(function(resolve, reject) {
    current[ url ]
      .then( resolve, reject );
  });
}


function isElementInViewport ( el ) {
  var rect = el.getBoundingClientRect();

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.left <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

function cacheVisitableLinks() {
  Turbolinks.controller.cache.size = 200;

  var links = Array.from(
    document.getElementsByTagName( 'a' )
  )
    .filter( isElementInViewport )
    .map(function(e) {
      return {
        element: e,
        location: Turbolinks.Location.wrap( e.href )
      };
    })
    .filter(function(obj) {
      return Turbolinks.controller.locationIsVisitable( obj.location );
    });

  links.forEach(function(obj) {
    if ( Turbolinks.controller.cache.has( obj.location ) ) {
      obj.element.setAttribute( 'data-turbolinks-action', 'restore' );
      obj.element.setAttribute( 'data-gu-instant', '' );

    } else {
      store( obj.location )
        .then(function() {
          obj.element.setAttribute( 'data-turbolinks-action', 'restore' );
          obj.element.setAttribute( 'data-gu-instant', '' );
        });
    }

  });

  console.log('links', links);
  console.log('parsed ' + links.length + ' links');
}

var throttleID;
window.addEventListener('scroll', function() {
  if ( throttleID ) {
    window.clearTimeout( throttleID );
    throttleID = undefined;
  }
  throttleID = window.setTimeout( cacheVisitableLinks, 500 );
});

document.addEventListener( 'turbolinks:load', function() {
  console.log('turbolinks:load');

  cacheVisitableLinks();
});

document.addEventListener( 'turbolinks:render', function() {
  Turbolinks.controller.scrollToAnchor('header');
});

require( [ 'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.4.2/localforage.js' ], function( localforage ) {
  console.log('localforage', localforage);
});
