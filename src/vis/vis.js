var _ = require('underscore');
var Backbone = require('backbone');
var $ = require('jquery');
var cdb = require('cdb');
var config = require('cdb.config');
var log = require('cdb.log');
var util = require('cdb.core.util');
var Loader = require('../core/loader');
var View = require('../core/view');
var Model = require('cdb/core/model');
var StackedLegend = require('../geo/ui/legend/stacked-legend');
var Map = require('../geo/map');
var MapView = require('../geo/map-view');
var LegendModel = require('../geo/ui/legend-model');
var Legend = require('../geo/ui/legend');
var SQL = require('../api/sql');
var Tooltip = require('../geo/ui/tooltip');
var InfowindowModel = require('../geo/ui/infowindow-model');
var Infowindow = require('../geo/ui/infowindow');
var Template = require('../core/template');
var Layers = require('./vis/layers');
var Overlay = require('./vis/overlay');
var INFOWINDOW_TEMPLATE = require('./vis/infowindow-template');
var WidgetsView = require('cdb/geo/ui/widgets/widgets_view');
var CartoDBLayerGroupNamed = require('cdb/geo/map/cartodb-layer-group-named');
var CartoDBLayerGroupAnonymous = require('cdb/geo/map/cartodb-layer-group-anonymous');
var RangeFilter = require('cdb/windshaft/filters/range');
var CategoryFilter = require('cdb/windshaft/filters/category');
var WidgetModelFactory = require('cdb/geo/ui/widgets/widget-model-factory');
var ListModel = require('cdb/geo/ui/widgets/list/model');
var HistogramModel = require('cdb/geo/ui/widgets/histogram/model');
var CategoryModel = require('cdb/geo/ui/widgets/category/model');
var FormulaModel = require('cdb/geo/ui/widgets/formula/model');
var WidgetViewFactory = require('cdb/geo/ui/widgets/widget-view-factory');
var ListContentView = require('cdb/geo/ui/widgets/list/content_view');
var HistogramContentView = require('cdb/geo/ui/widgets/histogram/content-view');
var TimeSeriesContentView = require('cdb/geo/ui/widgets/time-series/content-view');
var TorqueTimeSeriesContentView = require('cdb/geo/ui/widgets/time-series/torque-content-view');
var CategoryContentView = require('cdb/geo/ui/widgets/category/content_view');
var FormulaContentView = require('cdb/geo/ui/widgets/formula/content_view');
var WindshaftConfig = require('cdb/windshaft/config');
var WindshaftClient = require('cdb/windshaft/client');
var WindshaftDashboard = require('cdb/windshaft/dashboard');
var WindshaftPrivateDashboardConfig = require('cdb/windshaft/private-dashboard-config');
var WindshaftPublicDashboardConfig = require('cdb/windshaft/public-dashboard-config');
var DashboardInfoView = require('cdb/geo/ui/dashboard-info-view');

// Used to identify time-series widget for both the widget view factory as well as render it below the map instead of
// the default widgets list view
var isTimeSeriesWidget = function(m) {
  return m.isForTimeSeries;
};

/**
 * Visualization creation
 */
var Vis = View.extend({

  DEFAULT_MAX_ZOOM: 20,

  DEFAULT_MIN_ZOOM: 0,

  initialize: function() {
    _.bindAll(this, 'loadingTiles', 'loadTiles', '_onResize');

    var createFilter = function(Klass, attrs, layerIndex) {
      return new Klass({
        widgetId: attrs.id,
        layerIndex: layerIndex
      });
    };
    this.widgetModelFactory = new WidgetModelFactory({
      list: function(attrs) {
        return new ListModel(attrs);
      },
      formula: function(attrs) {
        return new FormulaModel(attrs);
      },
      histogram: function(attrs, layerIndex) {
        return new HistogramModel(attrs, {
          filter: createFilter(RangeFilter, attrs, layerIndex)
        });
      },
      'time-series': function(attrs, layerIndex) {
        // change type because time-series because it's really a histogram (for the tiler at least)
        attrs.type = 'histogram';
        var model = new HistogramModel(attrs, {
          filter: createFilter(RangeFilter, attrs, layerIndex)
        });

        // since we changed the type of we need some way to identify that it's intended for a time-series view later
        model.isForTimeSeries = true;

        return model;
      },
      aggregation: function(attrs, layerIndex) {
        return new CategoryModel(attrs, {
          filter: createFilter(CategoryFilter, attrs, layerIndex)
        });
      }
    });

    // TODO this should probably be extracted, together with the .load method
    this.widgetViewFactory = new WidgetViewFactory([
      {
        type: 'formula',
        createContentView: function(widget) {
          return new FormulaContentView({
            model: widget
          });
        }
      }, {
        type: 'list',
        createContentView: function(widget) {
          return new ListContentView({
            model: widget
          });
        }
      }, {
        // Torque time-series widget, keep before the normal time-series type to be instantiated if it's an torque layer
        match: function(widget, layer) {
          return layer.get('type') === 'torque' && isTimeSeriesWidget(widget);
        },
        createContentView: function(widget, layer) {
          return new TorqueTimeSeriesContentView({
            model: widget,
            rangeFilter: widget.filter,
            torqueLayerModel: layer
          });
        },
        customizeWidgetAttrs: function(attrs) {
          attrs.className += ' Widget--timeSeries';
          return attrs;
        }
      }, {
        match: isTimeSeriesWidget,
        createContentView: function(widget) {
          return new TimeSeriesContentView({
            model: widget,
            filter: widget.filter
          });
        },
        customizeWidgetAttrs: function(attrs) {
          attrs.className += ' Widget--timeSeries';
          return attrs;
        }
      }, {
        type: 'histogram',
        createContentView: function(widget) {
          return new HistogramContentView({
            dataModel: widget,
            viewModel: new Model(),
            filter: widget.filter
          });
        }
      }, {
        type: 'aggregation',
        createContentView: function(widget) {
          return new CategoryContentView({
            model: widget,
            filter: widget.filter
          });
        }
      }
    ]);

    this.https = false;
    this.overlays = [];
    this.moduleChecked = false;

    if (this.options.mapView) {
      this.mapView = this.options.mapView;
      this.map = this.mapView.map;
    }
  },

  /**
   * check if all the modules needed to create layers are loaded
   */
  checkModules: function(layers) {
    var mods = Layers.modulesForLayers(layers);
    return _.every(_.map(mods, function(m) { return cdb[m] !== undefined; }));
  },

  loadModules: function(layers, done) {
    var self = this;
    var mods = Layers.modulesForLayers(layers);
    for(var i = 0; i < mods.length; ++i) {
      Loader.loadModule(mods[i]);
    }
    function loaded () {
      if (self.checkModules(layers)) {
        config.unbind('moduleLoaded', loaded);
        done();
      }
    }

    config.bind('moduleLoaded', loaded);
    _.defer(loaded);
  },

  _addLegends: function(legends) {
    if (this.legends) {
      this.legends.remove();
    }

    this.legends = new StackedLegend({
      legends: legends
    });

    if (!this.mobile_enabled) {
      this.mapView.addOverlay(this.legends);
    }
  },

  addLegends: function(layers) {
    this._addLegends(this.createLegendView(layers));
  },

  _setLayerOptions: function(options) {
    var layers = [];

    // flatten layers (except baselayer)
    var layers = _.map(this.getLayers().slice(1), function(layer) {
      if (layer.getSubLayers) {
        return layer.getSubLayers();
      }
      return layer;
    });

    layers = _.flatten(layers);

    for (i = 0; i < Math.min(options.sublayer_options.length, layers.length); ++i) {

      var o = options.sublayer_options[i];
      var subLayer = layers[i];
      var legend = this.legends && this.legends.getLegendByIndex(i);

      if (legend) {
        legend[o.visible ? 'show': 'hide']();
      }

      // HACK
      if(subLayer.model && subLayer.model.get('type') === 'torque') {
        if (o.visible === false) {
          subLayer.model.set('visible', false);
        }
      }
    }
  },

  _addOverlays: function(overlays, data, options) {

    overlays = overlays.toJSON();
    // Sort the overlays by its internal order
    overlays = _.sortBy(overlays, function(overlay) {
      return overlay.order === null ? Number.MAX_VALUE: overlay.order;
    });

    // clean current overlays
    while (this.overlays.length !== 0) {
      this.overlays.pop().clean();
    }

    this._createOverlays(overlays, data, options);
  },

  _setupSublayers: function(layers, options) {
    options.sublayer_options = [];

    _.each(layers.slice(1), function(lyr) {

      if (lyr.type === 'layergroup') {
        _.each(lyr.options.layer_definition.layers, function(l) {
          options.sublayer_options.push({ visible: ( l.visible !== undefined ? l.visible : true ) })
        });
      } else if (lyr.type === 'namedmap') {
        _.each(lyr.options.named_map.layers, function(l) {
          options.sublayer_options.push({ visible: ( l.visible !== undefined ? l.visible : true ) })
        });
      } else if (lyr.type === 'torque') {
        options.sublayer_options.push({ visible: ( lyr.options.visible !== undefined ? lyr.options.visible : true ) })
      }
    });
  },

  load: function(data, options) {
    var self = this;

    if (typeof(data) === 'string') {
      var url = data;

      Loader.get(url, function(data) {
        if (data) {
          self.load(data, options);
        } else {
          self.throwError('error fetching viz.json file');
        }
      });

      return this;
    }

    // load modules needed for layers
    var layers = data.layers;

    if (!this.checkModules(layers)) {
      if (this.moduleChecked) {
        self.throwError("modules couldn't be loaded");
        return this;
      }

      this.moduleChecked = true;

      this.loadModules(layers, function() {
        self.load(data, options);
      });

      return this;
    }

    // TODO: This should be part of a model
    if (window && window.location.protocol && window.location.protocol === 'https:') {
      this.https = true;
    }

    if (data.https) {
      this.https = data.https;
    }

    options = options || {};

    this._applyOptions(data, options);

    // to know if the logo is enabled search in the overlays and see if logo overlay is included and is shown
    var has_logo_overlay = !!_.find(data.overlays, function(o) { return o.type === 'logo' && o.options.display; });

    this.cartodb_logo = (options.cartodb_logo !== undefined) ? options.cartodb_logo: has_logo_overlay;

    if (this.mobile) {
      this.cartodb_logo = false;
    } else if (!has_logo_overlay && options.cartodb_logo === undefined) {
      this.cartodb_logo = true;
    }

    var scrollwheel  = (options.scrollwheel === undefined)  ? data.scrollwheel : options.scrollwheel;

    // Do not allow pan map if zoom overlay and scrollwheel are disabled
    // Check if zoom overlay is present.
    var hasZoomOverlay = _.isObject(_.find(data.overlays, function(overlay) {
      return overlay.type == "zoom";
    }));

    var allowDragging = hasZoomOverlay || scrollwheel;

    //Force using GMaps ?
    if ( (this.gmaps_base_type) && (data.map_provider === "leaflet") ) {

      //Check if base_type is correct
      var typesAllowed = ['roadmap', 'gray_roadmap', 'dark_roadmap', 'hybrid', 'satellite', 'terrain'];
      if (_.contains(typesAllowed, this.gmaps_base_type)) {
        if (data.layers) {
          data.layers[0].options.type = 'GMapsBase';
          data.layers[0].options.base_type = this.gmaps_base_type;
          data.layers[0].options.name = this.gmaps_base_type;

          if (this.gmaps_style) {
            data.layers[0].options.style = typeof this.gmaps_style === 'string' ? JSON.parse(this.gmaps_style): this.gmaps_style;
          }

          data.map_provider = 'googlemaps';
          data.layers[0].options.attribution = ''; //GMaps has its own attribution
        } else {
          log.error('No base map loaded. Using Leaflet.');
        }
      } else {
        log.error('GMaps base_type "' + this.gmaps_base_type + ' is not supported. Using leaflet.');
      }
    }

    // Create the instance of the cdb.geo.Map model
    var mapConfig = {
      title: data.title,
      description: data.description,
      maxZoom: data.maxZoom || this.DEFAULT_MAX_ZOOM,
      minZoom: data.minZoom || this.DEFAULT_MIN_ZOOM,
      legends: data.legends,
      scrollwheel: scrollwheel,
      drag: allowDragging,
      provider: data.map_provider
    };

    // if the boundaries are defined, we add them to the map
    if (data.bounding_box_sw && data.bounding_box_ne) {
      mapConfig.bounding_box_sw = data.bounding_box_sw;
      mapConfig.bounding_box_ne = data.bounding_box_ne;
    }

    if (data.bounds) {
      mapConfig.view_bounds_sw = data.bounds[0];
      mapConfig.view_bounds_ne = data.bounds[1];
    } else {
      var center = data.center;

      if (typeof(center) === "string") {
        center = $.parseJSON(center);
      }

      mapConfig.center = center || [0, 0];
      mapConfig.zoom = data.zoom === undefined ? 4: data.zoom;
    }

    var map = new Map(mapConfig);
    this.map = map;
    this.overlayModels = new Backbone.Collection();

    // If a CartoDB embed map is hidden by default, its
    // height is 0 and it will need to recalculate its size
    // and re-center again.
    // We will wait until it is resized and then apply
    // the center provided in the parameters and the
    // correct size.
    var map_h = this.$el.outerHeight();

    if (map_h === 0) {
      this.mapConfig = mapConfig;
      $(window).bind('resize', this._onResize);
    }

    var div = $('<div>').css({
      position: 'relative',
      width: '100%',
      height: '100%'
    });

    this.container = div;

    // Another div to prevent leaflet grabbing the div
    var div_hack = $('<div>')
      .addClass("cartodb-map-wrapper")
      .css({
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%'
      });

    div.append(div_hack);

    this.$el.append(div);

    // Create the map
    var mapView  = new MapView.create(div_hack, map);

    this.mapView = mapView;

    if (options.legends || (options.legends === undefined && this.map.get("legends") !== false)) {
      map.layers.bind('reset', this.addLegends, this);
    }

    this.overlayModels.bind('reset', function(overlays) {
      this._addOverlays(overlays, data, options);
      this._addMobile(data, options);
    }, this);

    this.mapView.bind('newLayerView', this._addLoading, this);

    if (this.infowindow) {
      this.mapView.bind('newLayerView', this.addInfowindow, this);
    }

    if (this.tooltip) {
      this.mapView.bind('newLayerView', this.addTooltip, this);
    }

    var cartoDBLayers;
    var cartoDBLayerGroup;
    var layers = [];
    var interactiveLayers = [];
    _.each(data.layers, function(layerData) {
      if (layerData.type === 'layergroup' || layerData.type === 'namedmap') {
        var layersData;
        var layerGroupClass;
        if (layerData.type === 'layergroup') {
          layersData = layerData.options.layer_definition.layers;
          layerGroupClass = CartoDBLayerGroupAnonymous;
        } else {
          layersData = layerData.options.named_map.layers;
          layerGroupClass = CartoDBLayerGroupNamed;
        }
        cartoDBLayers = _.map(layersData, function(layerData) {
          var cartoDBLayer = Layers.create("cartodb", self, layerData);
          interactiveLayers.push(cartoDBLayer);
          return cartoDBLayer;
        });
        cartoDBLayerGroup = new layerGroupClass({}, {
          layers: cartoDBLayers
        });
        layers.push(cartoDBLayerGroup);
      } else {
        // Treat differently since this kind of layer is rendered client-side (and not through the tiler)
        var layer = Layers.create(layerData.type, self, layerData);
        layers.push(layer);
        if (layerData.type === 'torque') {
          interactiveLayers.push(layer);
        }
      }
    });

    // Initialize widgets
    var hasLayersWithWidgets = this._initializeWidgets(data, interactiveLayers, cartoDBLayerGroup);

    this.map.layers.reset(layers);
    this.overlayModels.reset(data.overlays);

    // if there are no sublayer_options fill it
    if (!options.sublayer_options) {
      this._setupSublayers(data.layers, options);
    }

    this._setLayerOptions(options);

    _.defer(function() {
      self.trigger('done', self, map.layers);
    });

    // TODO: rethink this, it is only a hack
    if (hasLayersWithWidgets) {
      setTimeout(function() {
        self.mapView.invalidateSize();
      }, 0);
    }

    return this;
  },

  /**
   * Initializes the widgets related classes.
   *
   * @private
   * @param  {Object} vizconfig         Object with viz data configuration.
   * @param  {Array.<Object>} interactiveLayers Array with references to
   * the layers withint the viz config.
   * @param  {(CartoDBLayerGroupNamed|CartoDBLayerGroupAnonymous)} cartoDBLayerGroup Layer group reference.
   * @return {boolean}  True if any layer contains widgets and has been initialized,
   * false otherwise.
   */
  _initializeWidgets: function(vizconfig, interactiveLayers, cartoDBLayerGroup) {

    // Create the widgets of each layer
    _.each(interactiveLayers, function(layer, layerIndex) {
      var widgetsAttrs = layer.get('widgets') || {};
      for (var id in widgetsAttrs) {
        var attrs = _.extend({
          id: id,
          layerId: layer.get('id')
        }, widgetsAttrs[id]);
        var widgetModel = this.widgetModelFactory.createModel(attrs, layerIndex);
        layer.widgets.add(widgetModel);
      }
    }, this);

    var isLayerWithTimeWidget = function(m) {
      return m.widgets.any(isTimeSeriesWidget);
    };

    // TODO WidgetView assumes all widgets to be rendered in one place which won't work for the time widget, could we
    // solve this differently/better? for now extract the layer (assumes there to only be one) and attach the view here
    var layer = _.find(interactiveLayers, isLayerWithTimeWidget);
    if (layer) {
      var widgetModel = layer.widgets.find(isTimeSeriesWidget);
      var view = this.widgetViewFactory.createWidgetView(widgetModel, layer);
      this.addView(view);
      $('.js-dashboard-belowMap').append(view.render().el);
    }

    // TODO: This will need to change when new layers are added / removed
    var layersWithWidgets = new Backbone.Collection(_.reject(interactiveLayers, isLayerWithTimeWidget));
    var widgetsView = new WidgetsView({
      widgetViewFactory: this.widgetViewFactory,
      layers: layersWithWidgets
    });
    $('.js-dashboard').append(widgetsView.render().el);

    var dashboard = new Model({
      title: vizconfig.title,
      description: vizconfig.description,
      updatedAt: vizconfig.updated_at,
      userName: vizconfig.user.fullname,
      userAvatarURL: vizconfig.user.avatar_url
    });
    var dashboardInfoView = new DashboardInfoView({
      model: dashboard
    });
    $('.js-dashboard').append(dashboardInfoView.render().el);

    // TODO: Perhaps this "endpoint" could be part of the "datasource"?
    var endpoint = WindshaftConfig.MAPS_API_BASE_URL;
    var configGenerator = WindshaftPublicDashboardConfig;
    var datasource = vizconfig.datasource;
    // TODO: We can use something else to differentiate types of "datasource"s
    if (datasource.template_name) {
      endpoint = [WindshaftConfig.MAPS_API_BASE_URL, 'named', datasource.template_name].join('/');
      configGenerator = WindshaftPrivateDashboardConfig;
    }

    var windshaftClient = new WindshaftClient({
      endpoint: endpoint,
      urlTemplate: datasource.maps_api_template,
      userName: datasource.user_name,
      statTag: datasource.stat_tag,
      forceCors: datasource.force_cors
    });

    var dashboard = new WindshaftDashboard({
      client: windshaftClient,
      configGenerator: configGenerator,
      statTag: datasource.stat_tag,
      //TODO: assuming here all viz.json has a layergroup and that may not be true
      layerGroup: cartoDBLayerGroup,
      layers: interactiveLayers,
      map: this.map
    });

    // TODO - Returns true or false depending if we found layers with widgets.
    // NOTE - This is only a fix to invoke the `map.invalidateSize()` method.
    var result = false;
    if (layersWithWidgets.size() > 0) {
      result = true;
    }
    return result;
  },

  _createOverlays: function(overlays, vis_data, options) {

    _(overlays).each(function(data) {
      var type = data.type;

      // We don't render certain overlays if we are in mobile
      if (this.mobile_enabled && (type === "zoom" || type === "header" || type === "loader")) return;

      // IE<10 doesn't support the Fullscreen API
      if (type === 'fullscreen' && util.browser.ie && util.browser.ie.version <= 10) return;

      // Decide to create or not the custom overlays
      if (type === 'image' || type === 'text' || type === 'annotation') {
        var isDevice = data.options.device == "mobile" ? true : false;
        if (this.mobile !== isDevice) return;
        if (!options[type] && options[type] !== undefined) {
          return;
        }
      }

      // We add the header overlay
      if (type === 'header') {
        var overlay = this._addHeader(data, vis_data);
      } else {
        var overlay = this.addOverlay(data);
      }

      // We show/hide the overlays
      if (overlay && (type in options) && options[type] === false) overlay.hide();

      var opt = data.options;

      if (!this.mobile_enabled) {

        if (type == 'share' && options["shareable"]  || type == 'share' && overlay.model.get("display") && options["shareable"] == undefined) overlay.show();
        if (type == 'layer_selector' && options[type] || type == 'layer_selector' && overlay.model.get("display") && options[type] == undefined) overlay.show();
        if (type == 'fullscreen' && options[type] || type == 'fullscreen' && overlay.model.get("display") && options[type] == undefined) overlay.show();
        if (type == 'search' && options[type] || type == 'search' && opt.display && options[type] == undefined) overlay.show();

        if (type === 'header') {

          var m = overlay.model;

          if (options.title !== undefined) {
            m.set("show_title", options.title);
          }

          if (options.description !== undefined) {
            m.set("show_description", options.description);
          }

          if (m.get('show_title') || m.get('show_description')) {
            $(".cartodb-map-wrapper").addClass("with_header");
          }

          overlay.render();
        }
      }
    }, this);
  },

  _addHeader: function(data, vis_data) {
    return this.addOverlay({
      type: 'header',
      options: data.options
    });
  },

  _addMobile: function(data, options) {
    var layers;
    var layer = data.layers[1];

    if (this.mobile_enabled) {

      if (options && options.legends === undefined) {
        options.legends = this.legends ? true : false;
      }

      if (layer.options && layer.options.layer_definition) {
        layers = layer.options.layer_definition.layers;
      } else if (layer.options && layer.options.named_map && layer.options.named_map.layers) {
        layers = layer.options.named_map.layers;
      }

      this.mobileOverlay = this.addOverlay({
        type: 'mobile',
        layers: layers,
        overlays: data.overlays,
        options: options,
        torqueLayer: this.torqueLayer
      });
    }
  },

  _createLegendView: function(layer, layerView) {
    if (layer.legend) {
      layer.legend.data = layer.legend.items;
      var legend = layer.legend;

      if ((legend.items && legend.items.length) || legend.template) {
        var legendAttrs = _.extend(layer.legend, {
          visible: layer.visible
        });
        var legendModel = new LegendModel(legendAttrs);
        var legendView = new Legend({ model: legendModel });
        layerView.bind('change:visibility', function(layer, hidden) {
          legendView[hidden ? 'hide': 'show']();
        });
        layerView.legend = legendModel;
        return legendView;
      }
    }
    return null;
  },

  createLegendView: function(layers) {
    var legends = [];
    var self = this;
    for (var i = layers.length - 1; i >= 0; --i) {
      var cid = layers.at(i).cid;
      var layer = layers.at(i).attributes;
      if (layer.visible) {
        var layerView = this.mapView.getLayerByCid(cid);
        if (layerView) {
          var layerView = this.mapView.getLayerByCid(cid);
          legends.push(this._createLayerLegendView(layer, layerView));
        }
      }
    }
    return _.flatten(legends);
  },

  _createLayerLegendView: function(layer, layerView) {
    var self = this;
    var legends = [];
    if (layer.options && layer.options.layer_definition) {
      var sublayers = layer.options.layer_definition.layers;
      _(sublayers).each(function(sub, i) {
        legends.push(self._createLegendView(sub, layerView.getSubLayer(i)));
      });
    } else if(layer.options && layer.options.named_map && layer.options.named_map.layers) {
      var sublayers = layer.options.named_map.layers;
      _(sublayers).each(function(sub, i) {
        legends.push(self._createLegendView(sub, layerView.getSubLayer(i)));
      });
    } else {
      legends.push(this._createLegendView(layer, layerView))
    }
    return _.compact(legends).reverse();
  },

  addOverlay: function(overlay) {
    overlay.map = this.map;

    var v = Overlay.create(overlay.type, this, overlay);

    if (v) {
      // Save tiles loader view for later
      if (overlay.type == "loader") {
        this.loader = v;
      }

      this.mapView.addOverlay(v);

      this.overlays.push(v);

      v.bind('clean', function() {
        for(var i in this.overlays) {
          var o = this.overlays[i];
          if (v.cid === o.cid) {
            this.overlays.splice(i, 1)
            return;
          }
        }
      }, this);
    }
    return v;
  },

  // change vizjson based on options
  _applyOptions: function(vizjson, opt) {
    opt = opt || {};
    opt = _.defaults(opt, {
      tiles_loader: true,
      loaderControl: true,
      infowindow: true,
      tooltip: true,
      time_slider: true
    });
    vizjson.overlays = vizjson.overlays || [];
    vizjson.layers = vizjson.layers || [];

    function search_overlay(name) {
      if (!vizjson.overlays) return null;
      for(var i = 0; i < vizjson.overlays.length; ++i) {
        if (vizjson.overlays[i].type === name) {
          return vizjson.overlays[i];
        }
      }
    }

    function remove_overlay(name) {
      if (!vizjson.overlays) return;
      for(var i = 0; i < vizjson.overlays.length; ++i) {
        if (vizjson.overlays[i].type === name) {
          vizjson.overlays.splice(i, 1);
          return;
        }
      }
    }

    this.infowindow = opt.infowindow;
    this.tooltip    = opt.tooltip;

    if (opt.https) {
      this.https = true;
    }

    if (opt.gmaps_base_type) {
      this.gmaps_base_type = opt.gmaps_base_type;
    }

    if (opt.gmaps_style) {
      this.gmaps_style = opt.gmaps_style;
    }

    this.mobile = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    this.mobile_enabled = (opt.mobile_layout && this.mobile) || opt.force_mobile;

    if (opt.force_mobile === false || opt.force_mobile === "false") this.mobile_enabled = false;

    // if (!opt.title) {
    //   vizjson.title = null;
    // }

    // if (!opt.description) {
    //   vizjson.description = null;
    // }

    if (!opt.tiles_loader) {
      remove_overlay('loader');
    }

    if (!opt.loaderControl) {
      remove_overlay('loader');
    }

    if (opt.searchControl !== undefined) {
      opt.search = opt.searchControl;
    }

    if (!this.mobile_enabled && opt.search) {
      if (!search_overlay('search')) {
        vizjson.overlays.push({
           type: "search",
           order: 3
        });
      }
    }

    if ( (opt.title && vizjson.title) || (opt.description && vizjson.description) ) {

      if (!search_overlay('header')) {
        vizjson.overlays.unshift({
          type: "header",
          order: 1,
          shareable: opt.shareable ? true: false,
          url: vizjson.url,
          options: {
            extra: {
              title: vizjson.title,
              description: vizjson.description,
              show_title: opt.title,
              show_description: opt.description
            }
          }
        });
      }
    }

    if (opt.layer_selector) {
      if (!search_overlay('layer_selector')) {
        vizjson.overlays.push({
          type: "layer_selector"
        });
      }
    }

    if (opt.shareable && !this.mobile_enabled) {
      if (!search_overlay('share')) {
        vizjson.overlays.push({
          type: "share",
          order: 2,
          url: vizjson.url
        });
      }
    }

    // We remove certain overlays in mobile devices
    if (this.mobile_enabled) {
      remove_overlay('logo');
      remove_overlay('share');
    }

    if (this.mobile || ((opt.zoomControl !== undefined) && (!opt.zoomControl)) ){
      remove_overlay('zoom');
    }

    if (this.mobile || ((opt.search !== undefined) && (!opt.search)) ){
      remove_overlay('search');
    }

    // if bounds are present zoom and center will not taken into account
    var zoom = parseInt(opt.zoom);
    if (!isNaN(zoom)) {
      vizjson.zoom = zoom;
      vizjson.bounds = null;
    }

    // Center coordinates?
    var center_lat = parseFloat(opt.center_lat);
    var center_lon = parseFloat(opt.center_lon);
    if ( !isNaN(center_lat) && !isNaN(center_lon) ) {
      vizjson.center = [center_lat, center_lon];
      vizjson.bounds = null;
    }

    // Center object
    if (opt.center !== undefined) {
      vizjson.center = opt.center;
      vizjson.bounds = null;
    }

    // Bounds?
    var sw_lat = parseFloat(opt.sw_lat);
    var sw_lon = parseFloat(opt.sw_lon);
    var ne_lat = parseFloat(opt.ne_lat);
    var ne_lon = parseFloat(opt.ne_lon);

    if ( !isNaN(sw_lat) && !isNaN(sw_lon) && !isNaN(ne_lat) && !isNaN(ne_lon) ) {
      vizjson.bounds = [
        [ sw_lat, sw_lon ],
        [ ne_lat, ne_lon ]
      ];
    }

    if (vizjson.layers.length > 1) {
      var token = opt.auth_token;
      function _applyLayerOptions(layers) {
        for(var i = 1; i < layers.length; ++i) {
          var o = layers[i].options;
          o.no_cdn = opt.no_cdn;
          o.force_cors = opt.force_cors;
          if(token) {
            o.auth_token = token;
          }
        }
      }
      _applyLayerOptions(vizjson.layers);
    }
  },

  createLayer: function(layerData, opts) {
    var layerModel = Layers.create(layerData.type || layerData.kind, this, layerData);
    return this.mapView.createLayer(layerModel);
  },

  _getSqlApi: function(attrs) {
    attrs = attrs || {};
    var port = attrs.sql_api_port
    var domain = attrs.sql_api_domain + (port ? ':' + port: '')
    var protocol = attrs.sql_api_protocol;
    var version = 'v1';
    if (domain.indexOf('cartodb.com') !== -1) {
      protocol = 'http';
      domain = "cartodb.com";
      version = 'v2';
    }

    var sql = new SQL({
      user: attrs.user_name,
      protocol: protocol,
      host: domain,
      version: version
    });

    return sql;
  },

  addTooltip: function(layerView) {

    var layers = layerView.model && layerView.model.layers || [];

    for(var i = 0; i < layers.length; ++i) {
      var layerModel = layers.at(i);
      var t = layerModel.getTooltipData();
      if (t) {
        if (!layerView.tooltip) {
          var tooltip = new Tooltip({
            mapView: this.mapView,
            layer: layerView,
            template: t.template,
            position: 'bottom|right',
            vertical_offset: 10,
            horizontal_offset: 4,
            fields: t.fields,
            omit_columns: ['cartodb_id']
          });
          layerView.tooltip = tooltip;
          this.mapView.addOverlay(tooltip);
          layerView.bind('remove', function() {
            this.tooltip.clean();
          });
        }
      }
    }

    if (layerView.tooltip) {
      layerView.bind("featureOver", function(e, latlng, pos, data, layer) {
        var t = layers.at(layer).getTooltipData();
        if (t) {
          layerView.tooltip.setTemplate(t.template);
          layerView.tooltip.setFields(t.fields);
          layerView.tooltip.setAlternativeNames(t.alternative_names);
          layerView.tooltip.enable();
        } else {
          layerView.tooltip.disable();
        }
      });
    }
  },

  addInfowindow: function(layerView) {
    var mapView = this.mapView;
    var infowindow = null;
    var layers = [];
    // TODO: this should be managed at a different level so each layer knows if
    // the infowindow needs to be added
    if (layerView.model) {
      if (layerView.model.layers) {
        layers = layerView.model.layers;
      } else {
        if (layerView.model.getInfowindowData) {
          layers = new Backbone.Collection([layerView.model]);
        }
      }
    }

    for(var i = 0; i < layers.length; ++i) {
      var layerModel = layers.at(i);
      if (layerModel.getInfowindowData()) {
        if(!infowindow) {
          infowindow = Overlay.create('infowindow', this, layerModel.getInfowindowData(), true);
          mapView.addInfowindow(infowindow);
        }
      }
    }

    if(!infowindow) {
      return;
    }

    infowindow.bind('close', function() {
      // when infowindow is closed remove all the filters
      // for tooltips
      for(var i = 0; i < layers; ++i) {
        var t = layerView.tooltip;
        if (t) {
          t.setFilter(null);
        }
      }
    });

    infowindow.model.bind('domready', function() {
      layerView.trigger('infowindow_ready', infowindow, this);
    }, this);

    // if the layer has no infowindow just pass the interaction
    // data to the infowindow
    layerView.bind('featureClick', function(e, latlng, pos, data, layer) {

        var infowindowFields = layers.at(layer).getInfowindowData();
        if (!infowindowFields) return;
        var cartodb_id = data.cartodb_id;

        layerView.model.fetchAttributes(layer, cartodb_id, function(attributes) {

          // Old viz.json doesn't contain width and maxHeight properties
          // and we have to get the default values if there are not defined.
          var extra = _.defaults(
            {
              offset: infowindowFields.offset,
              width: infowindowFields.width,
              maxHeight: infowindowFields.maxHeight
            },
            InfowindowModel.prototype.defaults
          );

          infowindow.model.set({
            'fields': infowindowFields.fields,
            'template': infowindowFields.template,
            'template_type': infowindowFields.template_type,
            'alternative_names': infowindowFields.alternative_names,
            'sanitizeTemplate': infowindowFields.sanitizeTemplate,
            'offset': extra.offset,
            'width': extra.width,
            'maxHeight': extra.maxHeight
          });

          if (attributes) {
            infowindow.model.updateContent(attributes);
            infowindow.adjustPan();
          } else {
            infowindow.setError();
          }
        });

        // Show infowindow with loading state
        infowindow
          .setLatLng(latlng)
          .setLoading()
          .showInfowindow();

        if (layerView.tooltip) {
          layerView.tooltip.setFilter(function(feature) {
            return feature.cartodb_id !== cartodb_id;
          }).hide();
        }
    });

    var hovers = [];

    layerView.bind('mouseover', function() {
      mapView.setCursor('pointer');
    });

    layerView.bind('mouseout', function(m, layer) {
      mapView.setCursor('auto');
    });

    layerView.infowindow = infowindow.model;
  },

  _addLoading: function (layerView) {
    if (layerView) {
      var self = this;

      var loadingTiles = function() {
        self.loadingTiles();
      };

      var loadTiles = function() {
        self.loadTiles();
      };

      layerView.bind('loading', loadingTiles);
      layerView.bind('load',    loadTiles);
    }
  },

  loadingTiles: function() {

    if (this.mobileOverlay) {
      this.mobileOverlay.loadingTiles();
    }

    if (this.loader) {
      this.loader.show()
    }
    if(this.layersLoading === 0) {
        this.trigger('loading');
    }
    this.layersLoading++;
  },

  loadTiles: function() {

    if (this.mobileOverlay) {
      this.mobileOverlay.loadTiles();
    }

    if (this.loader) {
      this.loader.hide();
    }
    this.layersLoading--;
    // check less than 0 because loading event sometimes is
    // thrown before visualization creation
    if(this.layersLoading <= 0) {
      this.layersLoading = 0;
      this.trigger('load');
    }
  },

  throwError: function(msg, lyr) {
    log.error(msg);
    var self = this;
    _.defer(function() {
      self.trigger('error', msg, lyr);
    });
  },

  error: function(fn) {
    return this.bind('error', fn);
  },

  done: function(fn) {
    return this.bind('done', fn);
  },

  // public methods
  //

  // get the native map used behind the scenes
  getNativeMap: function() {
    return this.mapView.getNativeMap();
  },

  // returns an array of layers
  getLayers: function() {
    var self = this;
    return _.compact(this.map.layers.map(function(layer) {
      return self.mapView.getLayerByCid(layer.cid);
    }));
  },

  getOverlays: function() {
    return this.overlays;
  },

  getOverlay: function(type) {
    return _(this.overlays).find(function(v) {
      return v.type == type;
    });
  },

  getOverlaysByType: function(type) {
    return _(this.overlays).filter(function(v) {
      return v.type == type;
    });
  },

  _onResize: function() {

    $(window).unbind('resize', this._onResize);

    var self = this;

    self.mapView.invalidateSize();

    // This timeout is necessary due to GMaps needs time
    // to load tiles and recalculate its bounds :S
    setTimeout(function() {

      var c = self.mapConfig;

      if (c.view_bounds_sw) {

        self.mapView.map.setBounds([
          c.view_bounds_sw,
          c.view_bounds_ne
        ]);

      } else {

        self.mapView.map.set({
          center: c.center,
          zoom: c.zoom
        });

      }
    }, 150);
  }
}, {

  /**
   * adds an infowindow to the map controlled by layer events.
   * it enables interaction and overrides the layer interacivity
   * ``fields`` array of column names
   * ``map`` native map object, leaflet of gmaps
   * ``layer`` cartodb layer (or sublayer)
   */
  addInfowindow: function(map, layer, fields, opts) {
    var options = _.defaults(opts || {}, {
      infowindowTemplate: INFOWINDOW_TEMPLATE.light,
      templateType: 'mustache',
      triggerEvent: 'featureClick',
      templateName: 'light',
      extraFields: [],
      cursorInteraction: true
    });

    if(!map) throw new Error('map is not valid');
    if(!layer) throw new Error('layer is not valid');
    if(!fields && fields.length === undefined ) throw new Error('fields should be a list of strings');

    var f = [];
    fields = fields.concat(options.extraFields);
    for(var i = 0; i < fields.length; ++i) {
      f.push({ name: fields, order: i});
    }

    var infowindowModel = new InfowindowModel({
      fields: f,
      template_name: options.templateName
    });

    var infowindow = new Infowindow({
       model: infowindowModel,
       mapView: map.viz.mapView,
       template: new Template({
         template: options.infowindowTemplate,
         type: options.templateType
       }).asFunction()
    });

    map.viz.mapView.addInfowindow(infowindow);
    // try to change interactivity, it the layer is a named map
    // it's inmutable so it'a assumed the interactivity already has
    // the fields it needs
    try {
      layer.setInteractivity(fields);
    } catch(e) {
    }
    layer.setInteraction(true);

    layer.bind(options.triggerEvent, function(e, latlng, pos, data, layer) {
      var render_fields = [];
      var d;
      for (var f = 0; f < fields.length; ++f) {
        var field = fields[f];
        if (d = data[field]) {
          render_fields.push({
            title: field,
            value: d,
            index: 0
          });
        }
      }

      infowindow.model.set({
        content:  {
          fields: render_fields,
          data: data
        }
      });

      infowindow
        .setLatLng(latlng)
        .showInfowindow();
      infowindow.adjustPan();
    }, infowindow);

    // remove the callback on clean
    infowindow.bind('clean', function() {
      layer.unbind(options.triggerEvent, null, infowindow);
    });

    if(options.cursorInteraction) {
      Vis.addCursorInteraction(map, layer);
    }

    return infowindow;
  },

  addCursorInteraction: function(map, layer) {
    var mapView = map.viz.mapView;
    layer.bind('mouseover', function() {
      mapView.setCursor('pointer');
    });

    layer.bind('mouseout', function(m, layer) {
      mapView.setCursor('auto');
    });
  },

  removeCursorInteraction: function(map, layer) {
    var mapView = map.viz.mapView;
    layer.unbind(null, null, mapView);
  }
});

module.exports = Vis;
