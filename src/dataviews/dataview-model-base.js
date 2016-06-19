var _ = require('underscore');
var Model = require('../core/model');
var BackboneCancelSync = require('../util/backbone-abort-sync');
var WindshaftFiltersBoundingBoxFilter = require('../windshaft/filters/bounding-box');
var BOUNDING_BOX_FILTER_WAIT = 500;

/**
 * Default dataview model
 */
module.exports = Model.extend({
  defaults: {
    url: '',
    data: [],
    sync_on_data_change: true,
    sync_on_bbox_change: true,
    enabled: true
  },

  url: function () {
    var params = _.union(
      [ this._getBoundingBoxFilterParam() ],
      this._getDataviewSpecificURLParams()
    );

    if (this.get('apiKey')) {
      params.push('api_key=' + this.get('apiKey'));
    }
    return this.get('url') + '?' + params.join('&');
  },

  _getBoundingBoxFilterParam: function () {
    var boundingBoxFilter = new WindshaftFiltersBoundingBoxFilter(this._map.getViewBounds());
    return 'bbox=' + boundingBoxFilter.toString();
  },

  /**
   * Subclasses might override this method to define extra params that will be appended
   * to the dataview's URL.
   * @return {[Array]} An array of strings in the form of "key=value".
   */
  _getDataviewSpecificURLParams: function () {
    return [];
  },

  initialize: function (attrs, opts) {
    attrs = attrs || {};
    opts = opts || {};

    if (!opts.map) {
      throw new Error('map is required');
    }

    if (!attrs.id) {
      this.set('id', this.defaults.type + '-' + this.cid);
    }

    this.layer = opts.layer;
    this._map = opts.map;

    this.sync = BackboneCancelSync.bind(this);

    // filter is optional, so have to guard before using it
    this.filter = opts.filter;
    if (this.filter) {
      this.filter.set('dataviewId', this.id);
    }

    this._initBinds();
  },

  _getLayerDataProvider: function () {
    return this.layer.getDataProvider();
  },

  _initBinds: function () {
    this.listenTo(this.layer, 'change:visible', this._onLayerVisibilityChanged);
    var layerDataProvider = this._getLayerDataProvider();
    if (layerDataProvider) {
      this.listenToOnce(layerDataProvider, 'dataChanged', this._onChangeBinds, this);
      this.listenTo(layerDataProvider, 'dataChanged', this.fetch);
    } else {
      this.listenToOnce(this, 'change:url', function () {
        this.fetch({
          success: this._onChangeBinds.bind(this)
        });
      });
    }
    if (this.filter) {
      this.listenTo(this.filter, 'change', this._onFilterChanged);
    }
  },

  /**
   * @private
   */
  _onFilterChanged: function (filter) {
    var layerDataProvider = this._getLayerDataProvider();
    if (layerDataProvider && layerDataProvider.canApplyFilterTo(this)) {
      layerDataProvider.applyFilter(this, filter);
    } else {
      this._reloadMap();
    }
  },

  /**
   * @protected
   */
  _reloadMap: function (opts) {
    opts = opts || {};
    this._map.reload(
      _.extend(
        opts, {
          sourceLayerId: this.layer.get('id')
        }
      )
    );
  },

  _reloadMapAndForceFetch: function () {
    this._reloadMap({
      forceFetch: true
    });
  },

  /**
   * Enable/disable the dataview depending on the layer visibility.
   * @private
   * @param  {LayerModel} model the layer model which visible property has changed.
   * @param  {Boolean} value New value for visible.
   * @returns {void}
   */
  _onLayerVisibilityChanged: function (model, value) {
    this.set({enabled: value});
  },

  _onChangeBinds: function () {
    this.listenTo(this._map, 'change:center change:zoom', _.debounce(this._onMapBoundsChanged.bind(this), BOUNDING_BOX_FILTER_WAIT));

    this.on('change:url', function (mdl, attrs, opts) {
      if (this.get('sync_on_data_change')) {
        this._newDataAvailable = true;
      }
      if ((opts && opts.forceFetch) || this._shouldFetchOnURLChange(opts && opts.sourceLayerId)) {
        this.fetch();
      }
    }, this);

    this.on('change:enabled', function (mdl, isEnabled) {
      if (isEnabled && this._newDataAvailable) {
        this.fetch();
        this._newDataAvailable = false;
      }
    }, this);
  },

  _onMapBoundsChanged: function () {
    if (this._shouldFetchOnBoundingBoxChange()) {
      this.fetch();
    }

    if (this.get('sync_on_bbox_change')) {
      this._newDataAvailable = true;
    }
  },

  _shouldFetchOnURLChange: function (sourceLayerId) {
    var urlChangeTriggeredBySameLayer = sourceLayerId && sourceLayerId === this.layer.get('id');
    return this.get('sync_on_data_change') && this.get('enabled') && urlChangeTriggeredBySameLayer;
  },

  _shouldFetchOnBoundingBoxChange: function () {
    return this.get('enabled') && this.get('sync_on_bbox_change');
  },

  refresh: function () {
    this.fetch();
  },

  update: function (attrs) {
    attrs = _.pick(attrs, this.constructor.ATTRS_NAMES);
    this.set(attrs);
  },

  getData: function () {
    return this.get('data');
  },

  getPreviousData: function () {
    return this.previous('data');
  },

  fetch: function (opts) {
    opts = opts || {};
    var layerDataProvider = this._getLayerDataProvider();
    if (layerDataProvider && layerDataProvider.canProvideDataFor(this)) {
      this.set(this.parse(layerDataProvider.getDataFor(this)));
    } else {
      this.trigger('loading', this);

      if (opts.success) {
        var successCallback = opts && opts.success;
      }

      return Model.prototype.fetch.call(this, _.extend(opts, {
        success: function () {
          successCallback && successCallback(arguments);
          this.trigger('loaded', this);
        }.bind(this),
        error: function (mdl, err) {
          if (!err || (err && err.statusText !== 'abort')) {
            this.trigger('error', mdl, err);
          }
        }.bind(this)
      }));
    }
  },

  toJSON: function () {
    throw new Error('toJSON should be defined for each dataview');
  },

  hasSameSourceAsLayer: function () {
    return this.getSourceId() === this.layer.get('source');
  },

  getSourceId: function () {
    return this.get('source').id;
  },

  remove: function () {
    if (this.filter) {
      this.filter.remove();
    }
    this.trigger('destroy', this);
    this.stopListening();
  }
},

  // Class props
  {
    ATTRS_NAMES: [
      'id',
      'sync_on_data_change',
      'sync_on_bbox_change',
      'enabled',
      'table',
      'source'
    ]
  }
);
