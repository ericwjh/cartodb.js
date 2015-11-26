<% if (isSearchEnabled) { %>
  <form class="Widget-search js-form">
    <i class="CDBIcon CDBIcon-Lens Widget-searchLens"></i>
    <input type="text" class="Widget-textInput Widget-searchTextInput js-textInput" value="<%- q %>" placeholder="search by <%- columnName %>"/>
    <% if (canShowApply) { %>
      <button type="button" class="Widget-link Widget-searchApply js-applyLocked">apply</button>
    <% } %>
  </form>
<% } else { %>
  <div class="Widget-title Widget-contentSpaced">
    <h3 class="Widget-textBig" title="<%- title %>"><%- title %></h3>
    <div class="Widget-options">
      <% if (canBeLocked) { %>
        <% if (isLocked) { %>
          <button class="Widget-buttonIcon Widget-buttonIcon--circle is-selected js-unlock">
            <i class="CDBIcon CDBIcon-Unlock CDBIcon--top"></i>
          </button>
        <% } else { %>
          <button class="Widget-buttonIcon Widget-buttonIcon--circle js-lock">
            <i class="CDBIcon CDBIcon-Lock CDBIcon--top"></i>
          </button>
        <% }  %>
      <% } %>
      <button class="Widget-buttonIcon Widget-buttonIcon--circle
        <%- isColorApplied ? 'is-selected' : '' %>
        <%- isColorApplied ? 'js-cancelColors' : 'js-applyColors' %>
        ">
        <i class="CDBIcon CDBIcon-Syringe CDBIcon--top"></i>
      </button>
      <button class="Widget-arrow js-collapse <%- isCollapsed ? 'Widget-arrow--down' : 'Widget-arrow--up' %> "></button>
    </div>
  </div>
<% } %>