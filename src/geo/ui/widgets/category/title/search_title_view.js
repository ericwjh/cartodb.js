var _ = require('underscore');
var cdb = require('cdb');
var $ = require('jquery');
var View = require('cdb/core/view');
var template = require('./search_title_template.tpl');

/**
 *  Show category title or search any category
 *  + another options for this widget, as in,
 *  colorize categories, lock defined categories...
 *
 */

module.exports = View.extend({

  events: {
    'keyup .js-textInput': '_onKeyupInput',
    'submit .js-form': '_onSubmitForm',
    'click .js-lock': '_lockCategories',
    'click .js-unlock': '_unlockCategories',
    'click .js-applyLocked': '_applyLocked',
    'click .js-applyColors': '_applyColors',
    'click .js-cancelColors': '_cancelColors',
    'click .js-collapse': '_toggleCollapse'
  },

  initialize: function() {
    this.viewModel = this.options.viewModel;
    this.dataModel = this.options.dataModel;
    this._initBinds();
  },

  render: function() {
    this.$el.html(
      template({
        isCollapsed: this.viewModel.isCollapsed(),
        isColorApplied: this.dataModel.isColorApplied(),
        title: this.dataModel.get('title'),
        columnName: this.dataModel.get('column'),
        q: this.dataModel.getSearchQuery(),
        isLocked: this.dataModel.isLocked(),
        canBeLocked: this.dataModel.canBeLocked(),
        isSearchEnabled: this.viewModel.isSearchEnabled(),
        canShowApply: this.dataModel.canApplyLocked()
      })
    );
    return this;
  },

  _initBinds: function() {
    this.viewModel.bind('change:search', this._onSearchToggled, this);
    this.viewModel.bind('change:collapsed', this.render, this);
    this.dataModel.bind('change:filter change:locked change:lockCollection change:categoryColors', this.render, this);
    this.add_related_model(this.dataModel);
    this.add_related_model(this.viewModel);
  },

  _onSearchToggled: function() {
    var isSearchEnabled = this.viewModel.isSearchEnabled();
    this[isSearchEnabled ? '_bindESC' : '_unbindESC']();
    this.render();
    if (isSearchEnabled) {
      this._focusOnInput();
    }
  },

  _onSubmitForm: function(ev) {
    if (ev) {
      ev.preventDefault();
    }
    var q = this.$('.js-textInput').val();
    if (this.dataModel.getSearchQuery() !== q) {
      this.dataModel.setSearchQuery(q);
      if (this.dataModel.isSearchValid()) {
        this.dataModel.applySearch();
      }
    }
  },

  _focusOnInput: function() {
    var self = this;
    setTimeout(function() {
      self.$('.js-textInput').focus();
    }, 0);
  },

  _onKeyupInput: _.debounce(
    function(ev) {
      var q = this.$('.js-textInput').val();
      if (ev.keyCode !== 13 && ev.keyCode !== 27 && q !== "") {
        this._onSubmitForm();
      }
    }, 250
  ),

  _bindESC: function() {
    $(document).bind("keyup." + this.cid, _.bind(this._onKeyUp, this));
  },

  _unbindESC: function() {
    $(document).unbind("keyup." + this.cid);
  },

  _onKeyUp: function(ev) {
    if (ev.keyCode === 27) {
      this._cancelSearch();
      return false;
    }
  },

  _lockCategories: function() {
    this.dataModel.lockCategories();
  },

  _unlockCategories: function() {
    this.dataModel.unlockCategories();
  },

  _applyLocked: function() {
    this.viewModel.toggleSearch();
    this.dataModel.applyLocked();
  },

  _applyColors: function() {
    this.dataModel.applyCategoryColors();
  },

  _cancelColors: function() {
    this.dataModel.cancelCategoryColors();
  },

  _cancelSearch: function() {
    this.dataModel.cleanSearch();
    this.viewModel.disableSearch();
  },

  _toggleCollapse: function() {
    this.viewModel.toggleCollapsed();
  },

  clean: function() {
    this._unbindESC();
    View.prototype.clean.call(this);
  }

});