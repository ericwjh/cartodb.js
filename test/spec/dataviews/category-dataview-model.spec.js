var _ = require('underscore');
var CategoryDataviewModel = require('../../../src/dataviews/category-dataview-model.js');
var WindshaftFiltersCategory = require('../../../src/windshaft/filters/category');

describe('dataviews/category-dataview-model', function () {
  beforeEach(function () {
    this.map = jasmine.createSpyObj('map', ['getViewBounds', 'bind', 'reload']);
    this.map.getViewBounds.and.returnValue([[1, 2], [3, 4]]);
    var windshaftMap = jasmine.createSpyObj('windhsaftMap', ['bind']);
    this.model = new CategoryDataviewModel(null, {
      map: this.map,
      windshaftMap: windshaftMap,
      layer: jasmine.createSpyObj('layer', ['get']),
      filter: new WindshaftFiltersCategory()
    });
  });

  it('should reload map on changing attrs', function () {
    this.map.reload.calls.reset();
    this.model.set('column', 'random_col');
    expect(this.map.reload).toHaveBeenCalled();

    this.map.reload.calls.reset();
    this.model.set('aggregation', 'count');
    expect(this.map.reload).toHaveBeenCalled();

    this.map.reload.calls.reset();
    this.model.set('aggregation_column', 'other');
    expect(this.map.reload).toHaveBeenCalled();
  });

  it('should define several internal models/collections', function () {
    expect(this.model._data).toBeDefined();
    expect(this.model._searchModel).toBeDefined();
    expect(this.model.filter).toBeDefined();
  });

  describe('binds', function () {
    beforeEach(function () {
      this.model.set({
        url: 'http://heytest.io'
      });
      // Simulating first interaction with client.js
      this.model._onChangeBinds();
    });

    describe('url', function () {
      beforeEach(function () {
        spyOn(this.model, 'fetch');
        spyOn(this.model._searchModel, 'fetch');
        spyOn(this.model._rangeModel, 'fetch');
      });

      it('should set search url when it changes', function () {
        expect(this.model._searchModel.get('url')).toBe('http://heytest.io');
        expect(this.model._searchModel.url()).toBe('http://heytest.io/search?q=');
      });

      it('should set rangeModel url when it changes', function () {
        expect(this.model._rangeModel.get('url')).toBe('http://heytest.io');
        expect(this.model._rangeModel.url()).toBe('http://heytest.io');
      });
    });

    describe('boundingBox', function () {
      it('should set search boundingBox when it changes', function () {
        this.model.set('boundingBox', 'hey');
        expect(this.model._searchModel.get('boundingBox')).toBe('hey');
      });

      it('should fetch itself if bounding box changes only when search is not applied', function () {
        spyOn(this.model, '_fetch');
        spyOn(this.model, 'isSearchApplied').and.returnValue(true);
        this.model.set('boundingBox', 'comeon');
        expect(this.model._fetch).not.toHaveBeenCalled();
      });
    });

    describe('search events dispatcher', function () {
      it('should trigger search related events', function () {
        var eventNames = ['loading', 'sync', 'error'];
        _.each(eventNames, function (eventName) {
          _.bind(eventDispatcher, this)(this.model._searchModel, eventName);
        }, this);
      });

      it('should trigger a change:searchData when search model is fetched', function () {
        _.bind(eventDispatcher, this)(this.model._searchModel, 'change:data', 'change:searchData');
      });
    });

    describe('range model', function () {
      it('should set totalCount when rangeModel has changed', function () {
        expect(this.model.get('totalCount')).toBeUndefined();
        this.model._rangeModel.set({ totalCount: 1000 });
        expect(this.model.get('totalCount')).toBe(1000);
      });

      it('should set categoriesCount when rangeModel has changed', function () {
        expect(this.model.get('categoriesCount')).toBeUndefined();
        this.model._rangeModel.set({ categoriesCount: 123 });
        expect(this.model.get('categoriesCount')).toBe(123);
      });
    });
  });

  describe('search model helpers', function () {
    it('should clean search properly', function () {
      spyOn(this.model._searchModel, 'resetData');
      this.model.cleanSearch();
      expect(this.model._searchModel.resetData).toHaveBeenCalled();
    });

    describe('setupSearch', function () {
      beforeEach(function () {
        spyOn(this.model._searchModel, 'setData').and.callThrough();
      });

      it('should not setup search if search is already applied', function () {
        spyOn(this.model, 'isSearchApplied').and.returnValue(true);
        this.model.setupSearch();
        expect(this.model._searchModel.setData).not.toHaveBeenCalled();
      });

      it('should setup search if it is gonna be enabled', function () {
        spyOn(this.model, 'isSearchApplied').and.returnValue(false);
        _parseData(this.model, _generateData(3));
        this.model.filter.accept(['4', '5', '6']);
        this.model.setupSearch();
        expect(this.model._searchModel.setData).toHaveBeenCalled();
        expect(this.model.getSearchCount()).toBe(3);
      });
    });
  });

  it('should refresh its own data only if the search is not applied', function () {
    spyOn(this.model, '_fetch');
    spyOn(this.model._searchModel, 'fetch');
    this.model.refresh();
    expect(this.model._fetch.calls.count()).toEqual(1);
    expect(this.model._fetch).toHaveBeenCalled();
    expect(this.model._searchModel.fetch).not.toHaveBeenCalled();
    spyOn(this.model, 'isSearchApplied').and.returnValue(true);
    this.model.refresh();
    expect(this.model._searchModel.fetch).toHaveBeenCalled();
    expect(this.model._fetch.calls.count()).toEqual(1);
  });

  describe('.parse', function () {
    it('should change internal data collection when parse is called', function () {
      var resetSpy = jasmine.createSpy('reset');
      this.model._data.bind('reset', resetSpy);

      _parseData(this.model, _generateData(2));
      expect(resetSpy).toHaveBeenCalled();
    });

    it('should cast any category value to string', function () {
      _parseData(this.model, _.map([null, undefined, 0, 'hello', false], function (v) {
        return {
          category: v,
          value: 1
        };
      }));
      var areNamesString = _.every(this.model.get('data'), function (obj) {
        return obj.name;
      });
      expect(areNamesString).toBeTruthy();
    });

    describe('when enableFilter is enabled', function () {
      it('should NOT add categories that are accepted when they are not present in the new categories', function () {
        this.model.filter.accept('Madrid');

        // Enable `enableFilter`
        this.model.set('enableFilter', true);

        _parseData(this.model, _.map(['Barcelona'], function (v) {
          return {
            category: v,
            value: 1
          };
        }));

        var categories = this.model.get('data');
        expect(categories.length).toEqual(1);
        expect(categories[0].name).toEqual('Barcelona');
      });
    });

    describe('when enableFilter is disabled', function () {
      it('should add categories that are accepted when they are not present in the new categories', function () {
        this.model.filter.accept('Madrid');

        // Disable `enableFilter`
        this.model.set('enableFilter', false);

        _parseData(this.model, _.map(['Barcelona'], function (v) {
          return {
            category: v,
            value: 1
          };
        }));

        var categories = this.model.get('data');
        expect(categories.length).toEqual(2);
        expect(categories[0].name).toEqual('Barcelona');
        expect(categories[1].name).toEqual('Madrid');
      });
    });
  });

  describe('.update', function () {
    beforeEach(function () {
      expect(this.model.get('foo')).toBeUndefined();
      expect(this.model.get('sync_on_bbox_change')).toBe(true);
      expect(this.model.get('aggregation')).not.toEqual('sum');
      this.model.update({
        sync_on_bbox_change: false,
        aggregation: 'sum',
        foo: 'bar'
      });
    });

    it('should allow to set attrs but only the defined ones', function () {
      expect(this.model.get('sync_on_bbox_change')).toBe(false);
      expect(this.model.get('aggregation')).toEqual('sum');
      expect(this.model.get('foo')).toBeUndefined();
    });
  });
});

function eventDispatcher (originModel, eventName, triggerName) {
  var spyObj = jasmine.createSpy(eventName);
  this.model.bind(triggerName || eventName, spyObj);
  originModel.trigger(eventName);
  expect(spyObj).toHaveBeenCalled();
}

function _generateData (n) {
  return _.times(n, function (i) {
    return {
      category: i,
      value: 2
    };
  });
}

function _parseData (model, categories) {
  model.sync = function (method, model, options) {
    options.success({
      'categories': categories
    });
  };
  model.fetch();
}