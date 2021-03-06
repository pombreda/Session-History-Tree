/*
    Session History Tree, extension for Firefox 13.0+
    Copyright (C) 2011  Daniel Dawson <ddawson@icehouse.net>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

var EXPORTED_SYMBOLS = ["sessionHistoryTree"];

const Cc = Components.classes, Ci = Components.interfaces,
      Cu = Components.utils;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyServiceGetter(
  this, "sStore", "@mozilla.org/browser/sessionstore;1", "nsISessionStore");
XPCOMUtils.defineLazyServiceGetter(
  this, "faviconSvc", "@mozilla.org/browser/favicon-service;1",
  "nsIFaviconService");
XPCOMUtils.defineLazyServiceGetter(
  this, "promptSvc", "@mozilla.org/embedcomp/prompt-service;1",
  "nsIPromptService");
XPCOMUtils.defineLazyGetter(
  this, "prefs", function ()
    Services.prefs.getBranch("extensions.sessionhistorytree."));
XPCOMUtils.defineLazyGetter(
  this, "strings", function ()
    Services.strings.createBundle(
      "chrome://sessionhistorytree/locale/sht.properties"));

function log (aMsg) {
  if (prefs.getBoolPref("log"))
    Services.console.logStringMessage("Session History Tree: " + aMsg);
}

function thisWrap (func, thisObj)
  function () func.apply(thisObj, arguments);

var sessionHistoryTree = {
  nextWindowID: 0,
  nextBrowserID: 0,
  sHistoryHandlers: {},

  registerLoadHandler: function (win) {
    win.addEventListener(
      "load",
      function (evt) { sessionHistoryTree.windowLoadHandler(evt); },
      false);
  },

  windowLoadHandler: function __wlHandler (evt) {
    log("new window");
    var theWindow = evt.target.defaultView;
    this.giveNewWindowID(theWindow);
    var gBr = theWindow.gBrowser, tc = gBr.tabContainer;

    for (let i = 0; i < tc.itemCount; i++) {
      log("found a tab initially");
      let theTab = tc.getItemAtIndex(i),
          theBrowser = gBr.browsers[i];

      let callback = thisWrap(function () {
        log("initial tab loaded");
        try {
          var newSHHandler = new SHistoryHandler(theTab, theBrowser);
        } catch (e if e.name == "NS_ERROR_ILLEGAL_VALUE") {
          return;
        }

        this.giveNewBrowserID(theWindow, theBrowser, newSHHandler);
        theTab.removeEventListener("load", callback, false);
      }, this);

      theTab.addEventListener("load", callback, false);
    }

    tc.addEventListener(
      "TabOpen",
      thisWrap(function (evt) {
          log("TabOpen");
          var theTab = evt.target, theBrowser = gBr.getBrowserForTab(theTab);
          var newSHHandler = new SHistoryHandler(theTab, theBrowser);
          var theWindow = theTab.ownerDocument.defaultView;
          this.giveNewBrowserID(theWindow, theBrowser, newSHHandler);
        }, this),
      false);

    tc.addEventListener(
      "TabClose",
      thisWrap(function (evt) {
          log("TabClose");
          var theTab = evt.target, theBrowser = gBr.getBrowserForTab(theTab);
          var winID = theWindow.sessionHistoryTree_ID,
              brsID = theBrowser.sessionHistoryTree_ID;
          delete this.sHistoryHandlers[winID][brsID];
        }, this),
      false);

    tc.addEventListener(
      "SSTabRestored",
      thisWrap(function (evt) {
          log("SSTabRestored");
          var winID = theWindow.sessionHistoryTree_ID;
          for each (let handler in this.sHistoryHandlers[winID])
            handler.endRestorePhase();
        }, this),
      false);

    theWindow.FillHistoryMenu =
      getSHTFillHistoryMenu(theWindow.FillHistoryMenu);

    theWindow.removeEventListener("load", __wlHandler, false);
  },

  giveNewWindowID: function (aWindow) {
    var id = this.nextWindowID++;
    aWindow.sessionHistoryTree_ID = id;
    this.sHistoryHandlers[id] = {};
  },

  giveNewBrowserID: function (aWindow, aBrowser, aSHistoryHandler) {
    var winID = aWindow.sessionHistoryTree_ID,
        brsID = this.nextBrowserID++;
    aBrowser.sessionHistoryTree_ID = brsID;
    this.sHistoryHandlers[winID][brsID] = aSHistoryHandler;
  },

  clearTree: function (aWindow) {
    var winID = aWindow.sessionHistoryTree_ID;
    var brsID = aWindow.gBrowser.selectedBrowser.sessionHistoryTree_ID;
    this.sHistoryHandlers[winID][brsID].clearTree();
  },
};

function SHistoryHandler (aTab, aBrowser) {
  log("new SHistoryHandler");
  this.tab = aTab;
  this.browser = aBrowser;
  this.restorePhase = false;
  this._initTreeFromSessionStore();
  this.registerSelf();
  aBrowser.webProgress.addProgressListener(
    this,
    Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT
      | Ci.nsIWebProgress.NOTIFY_LOCATION);
  this.request = null;
  this.stopped = false;
}

SHistoryHandler.prototype = {
  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsISHistoryListener, Ci.nsIWebProgressListener,
    Ci.nsISupports, Ci.nsISupportsWeakReference]),

  registerSelf: function () {
    var sHist = this.browser.sessionHistory;
    try {
      sHist.removeSHistoryListener(this);
    } catch (e) {}
    sHist.addSHistoryListener(this);
  },

  startRestorePhase: function () {
    log("startRestorePhase (" + this.browser.contentDocument.title + ")");
    this.restorePhase = true;
  },

  endRestorePhase: function () {
    log("endRestorePhase (" + this.browser.contentDocument.title + ")");
    this.restorePhase = false;
    this.registerSelf();

    var shtStr = sStore.getTabValue(this.tab, "sessionHistoryTree");
    if (!shtStr)
      this._initTreeFromSessionStore();
    else
      this.sht = JSON.parse(shtStr);
  },

  clearTree: function () {
    if (prefs.getBoolPref("promptonclear")) {
      let res = promptSvc.confirmEx(
        this.browser.contentWindow,
        strings.GetStringFromName("clearingtree_title"),
        strings.GetStringFromName("clearingtree_label"),
        promptSvc.BUTTON_POS_1_DEFAULT + promptSvc.STD_YES_NO_BUTTONS
        + promptSvc.BUTTON_TITLE_IS_STRING*promptSvc.BUTTON_POS_2, null,
          null, strings.GetStringFromName("clearingtree_always"), null, {});

      if (res == 1) return;
      if (res == 2)
        prefs.setBoolPref("promptonclear", false);
    }

    this._initTreeFromSessionStore();
    log("tree cleared");
  },

  _initTreeFromSessionStore: function () {
    log("_initTreeFromSessionStore");
    var st = JSON.parse(sStore.getTabState(this.tab));

    this.sht = {
      tree: [],
      curPathPos: st.index - 1,
      curPathLength: st.entries.length
    };

    var tree = this.sht.tree;

    for (var i = 0; i < st.entries.length; i++) {
      let node = {
        entry: st.entries[i],
        subtree: []
      };
      tree.push(node);
      tree = node.subtree;
    }

    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));
  },

  OnHistoryGoBack: function (aBackURI) {
    log("HistoryGoBack");
    this.restorePhase = false;
    var tabSt = JSON.parse(sStore.getTabState(this.tab));

    this.sht.curPathPos = tabSt.index;
    var curTree = this.sht.tree, curNode;

    for (var i = 0; i < this.sht.curPathPos; i++) {
      curNode = curTree[0];
      curTree = curNode.subtree;
    }

    if (curNode)
      curNode.entry = tabSt.entries[tabSt.index - 1];
    
    this.sht.curPathPos--;
    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));
    return true;
  },

  OnHistoryGoForward: function (aForwardURI) {
    log("HistoryGoForward");
    this.restorePhase = false;
    var tabSt = JSON.parse(sStore.getTabState(this.tab));

    this.sht.curPathPos = tabSt.index;
    var curTree = this.sht.tree, curNode;

    for (var i = 0; i < this.sht.curPathPos; i++) {
      curNode = curTree[0];
      curTree = curNode.subtree;
    }

    if (curNode)
      curNode.entry = tabSt.entries[tabSt.index - 1];

    this.sht.curPathPos++;
    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));
    return true;
  },

  OnHistoryGotoIndex: function (aIndex, aGotoURI) {
    log("HistoryGotoIndex");
    if (this.restorePhase) return true;
    var tabSt = JSON.parse(sStore.getTabState(this.tab));

    this.sht.curPathPos = tabSt.index;
    var curTree = this.sht.tree, curNode;

    for (var i = 0; i < this.sht.curPathPos; i++) {
      curNode = curTree[0];
      curTree = curNode.subtree;
    }

    if (curNode)
      curNode.entry = tabSt.entries[tabSt.index - 1];
    this.sht.curPathPos = aIndex + 1;

    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));
    return true;
  },

  OnHistoryNewEntry: function (aNewURI) {
    log("HistoryNewEntry");
    var tabSt = JSON.parse(sStore.getTabState(this.tab));
    if (this.restorePhase) return true;

    this.sht.curPathPos = tabSt.index;
    var curTree = this.sht.tree, curNode = null;

    for (var i = 0; i < this.sht.curPathPos; i++) {
      curNode = curTree[0];
      curTree = curNode.subtree;
    }

    var curIndex = this.browser.sessionHistory.index;
    if (curNode)
      curNode.entry = tabSt.entries[curIndex];

    this.sht.curPathPos++;
    if (curNode && curTree.length)
      this.sht.curPathLength = this.sht.curPathPos;
    else if (curIndex == this.sht.curPathLength - 1)
      this.sht.curPathLength++;

    var newNode = {
      entry: { url: aNewURI.spec, title: "SHTInit", ID: null, scroll: "0,0" },
      subtree: []
    };
    curTree.unshift(newNode);

    var branchLimit = prefs.getIntPref("branchlimit");
    if (curTree.length > branchLimit) {
      let numDel = curTree.length - branchLimit;
      curTree.splice(-numDel, numDel);
    }

    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));

    var thisObj = this;
    this.browser.addEventListener(
      "DOMContentLoaded",
      function __dclHandler () {
        thisObj._dclHandler(curIndex + 1, newNode);
        thisObj.browser.removeEventListener(
          "DOMContentLoaded", __dclHandler, false)
      },
      false);

    return true;
  },

  OnHistoryPurge: function (aNumEntries) {
    log("HistoryPurge (" + aNumEntries + ")");
    if (this.restorePhase) return true;
    var tabSt = JSON.parse(sStore.getTabState(this.tab));

    var curRoot = this.sht.tree;
    sht.curPathPos = tabSt.index - aNumEntries;

    for (var i = 0; i < aNumEntries; i++)
      curRoot = curRoot.reduce(
        function (prev, cur) prev.concat(cur.subtree), []);
    this.sht.tree = curRoot;

    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));
    return true;
  },

  OnHistoryReload: function (aReloadURI, aReloadFlags) {
    log("OnHistoryReload");

    var tabSt = JSON.parse(sStore.getTabState(this.tab));
    this.sht.curPathPos = tabSt.index;
    var curTree = this.sht.tree, curNode = null;

    for (var i = 0; i < this.sht.curPathPos; i++) {
      curNode = curTree[0];
      curTree = curNode.subtree;
    }

    var curIndex = this.browser.sessionHistory.index;
    if (curNode) curNode.entry = tabSt.entries[curIndex];
    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));

    var thisObj = this;
    this.browser.addEventListener(
      "DOMContentLoaded",
      function __dclHandler () {
        thisObj._dclHandler(curIndex, curNode);
        thisObj.browser.removeEventListener(
          "DOMContentLoaded", __dclHandler, false);
      },
      false);

    return true;
  },

  _dclHandler: function (curIndex, updateNode) {
    log("DOMContentLoaded");
    var entry = JSON.parse(sStore.getTabState(this.tab)).entries[curIndex];

    // Prevent recursion, as with about:sessionrestore
    if (entry.url.substring(0, 6)) {
      if (entry.hasOwnProperty("formdata"))
        delete entry.formdata;
    }

    updateNode.entry = entry;
    sStore.setTabValue(this.tab, "sessionHistoryTree",
                       JSON.stringify(this.sht));

    var tab = this.tab, sht = this.sht;
    var domWin = this.browser.contentWindow;

    this.browser.removeEventListener("DOMContentLoaded", this._dclHandler,
                                     false);
    if (this.stopped) return;

    domWin.addEventListener(
      "load",
      function __wlHandler () {
        log("load");
        var entry = JSON.parse(sStore.getTabState(tab)).entries[curIndex];
        updateNode.entry = entry;

        // Prevent recursion, as with about:sessionrestore
        if (entry.url.substring(0, 6)) {
          if (entry.hasOwnProperty("formdata"))
            delete entry.formdata;
        }

        sStore.setTabValue(tab, "sessionHistoryTree", JSON.stringify(sht));
        domWin.removeEventListener("load", __wlHandler, false);
      },
      false);
  },

  onLocationChange: function (aWebProgress, aRequest, aLocation) {
    log("LocationChange (" + aRequest.name + "): " + aLocation.spec);
    this.request = aRequest;
    this.stopped = false;
  },

  onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
    // 0x804b0002
    log("StateChange (" + aRequest.name + "): "
        + aStateFlags + ", " + aStatus);
    if (aStateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
      this.request = null;
      if (aStatus == 0x804b0002) {  // Is that value documented anywhere?
        log("stopped");
        this.stopped = true;
      }
    }
  },
};

function getSHTFillHistoryMenu (aOldFHM)
  function (aParent) {
    log("FillHistoryMenu");
    var res = aOldFHM(aParent);
    if (!res) return false;

    var children = aParent.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i].tagName == "hbox")
        aParent.removeChild(children[i]);
    }

    var document = aParent.ownerDocument;
    var tab = document.defaultView.gBrowser.selectedTab;

    var pathLen = aParent.firstChild.getAttribute("index");
    var path = [];
    for (var i = 0; i <= pathLen; i++) path.push(0);
    var multis = getSHTPathMultis(tab, pathLen);

    for (let i = 0; i < children.length; i++) {
      let item = children[i];
      item.classList.add("sessionhistorytree-item");
      item.setAttribute("flex", "1");
      item.setAttribute("shtpath", path.toString());
      path.pop();

      if (multis.pop()) {
        let hbox = document.createElement("hbox");
        aParent.replaceChild(hbox, item);
        hbox.appendChild(item);
        let sm = document.createElement("menu");
        sm.className = "menu-iconic sessionhistorytree-submenu";
        let smPopup = document.createElement("menupopup");
        smPopup.setAttribute("shtpath", path.toString());
        smPopup.addEventListener("popupshowing", fillTreeSubmenu, false);
        smPopup.addEventListener("command", switchPath, false);
        sm.appendChild(smPopup);
        hbox.appendChild(sm);
      }
    }

    return true;
  };

function getSHTPathMultis (aTab, aEndIndex) {
  var sht = JSON.parse(sStore.getTabValue(aTab, "sessionHistoryTree"));
  var node = sht.tree[0];
  var multis = [sht.tree.length > 1];

  for (var i = 0; i < aEndIndex; i++) {
    if (node.subtree.length > 0) multis.push(node.subtree.length > 1);
    node = node.subtree[0];
  }

  return multis;
}

function fillTreeSubmenu (evt) {
  log("fillTreeSubmenu");
  var popup = evt.target;
  var popupPathStr = popup.getAttribute("shtpath");

  if (popupPathStr == "")
    var popupPath = [];
  else
    var popupPath = popupPathStr.split(",");

  var document = popup.ownerDocument, window = document.defaultView,
      tab = window.gBrowser.selectedTab,
      browser = window.gBrowser.selectedBrowser,
      winID = window.sessionHistoryTree_ID,
      brsID = browser.sessionHistoryTree_ID;

  var ts = JSON.parse(sStore.getTabState(tab));
  var sht = sessionHistoryTree.sHistoryHandlers[winID][brsID].sht;
  var tree = sht.tree, node,
      isCurPath = (popupPath.length == sht.curPathPos - 1);

  for (var i = 0; i < popupPath.length; i++) {
    let pathIdx = popupPath[i];
    if (sht.curPathPos > i + 1 && pathIdx != 0)
      isCurPath = false;
    node = tree[popupPath[i]];
    tree = node.subtree;
  }

  while (popup.hasChildNodes())
    popup.removeChild(popup.lastChild);

  var lastIdx;
  if (isCurPath)
    lastIdx = 0;
  else
    lastIdx = -1;

  for (i = 0; i < tree.length; i++) {
    node = tree[i];
    let entry;

    if (i == lastIdx) {
      entry = ts.entries[sht.curPathPos - 1];
      node.entry = entry;
      sStore.setTabValue(tab, "sessionHistoryTree", JSON.stringify(sht));
    } else
      entry = node.entry;

    let item = document.createElement("menuitem");
    popup.appendChild(item);
    item.setAttribute("label", entry.title || entry.url);
    item.setAttribute("uri", entry.url);
    item.setAttribute("tooltiptext",
                      strings.GetStringFromName("switchpath_tooltip"));
    let itemPath = popupPath.concat(i);
    item.className = "sessionhistorytree-item";
    item.setAttribute("flex", "1");
    item.setAttribute("shtpath", itemPath.toString());

    if (isCurPath && i == lastIdx) {
      item.setAttribute("type", "radio");
      item.setAttribute("checked", "true");
    } else {
      item.classList.add("menuitem-iconic");
      let uri = Services.io.newURI(entry.url, null, null);

      try {
        let asyncItem = item;
        faviconSvc.getFaviconURLForPage(
          uri, { onComplete: function (aURI, aDataLen, aData, aMimeType) {
            asyncItem.style.listStyleImage =
              'url("' + faviconSvc.getFaviconLinkForIcon(aURI).spec + '")';
          }});
      } catch (e) {}
    }

    if (node.subtree.length > 0) {
      let hbox = document.createElement("hbox");
      popup.replaceChild(hbox, item);
      hbox.appendChild(item);
      let sm = document.createElement("menu");
      sm.className = "menu-iconic sessionhistorytree-submenu";
      let smPopup = document.createElement("menupopup");
      smPopup.setAttribute("shtpath", itemPath.toString());
      smPopup.addEventListener("popupshowing", fillTreeSubmenu, false);
      sm.appendChild(smPopup);
      hbox.appendChild(sm);
    }
  }

  evt.stopPropagation();
}

function switchPath (evt) {
  log("switchPath");
  evt.stopPropagation();
  var item = evt.target, targetPath = item.getAttribute("shtpath").split(",");
  var window = item.ownerDocument.defaultView,
      browser = window.gBrowser.selectedBrowser,
      tab = window.gBrowser.selectedTab,
      winID = window.sessionHistoryTree_ID,
      brsID = browser.sessionHistoryTree_ID;
  var sht = sessionHistoryTree.sHistoryHandlers[winID][brsID].sht;
  var entries = [];
  var tree = sht.tree, node;

  for (var i = 0; i < targetPath.length; i++) {
    node = tree.splice(targetPath[i], 1)[0];
    tree.unshift(node);
    entries.push(node.entry);
    tree = node.subtree;
  }

  sht.curPathPos = i;
  sStore.setTabValue(tab, "sessionHistoryTree", JSON.stringify(sht));

  while (tree.length > 0) {
    node = tree[0];
    entries.push(node.entry);
    tree = node.subtree;
  }

  var ts = JSON.parse(sStore.getTabState(tab));
  ts.entries = entries;
  ts.index = i;
  var winID = window.sessionHistoryTree_ID,
      brsID = browser.sessionHistoryTree_ID;
  sessionHistoryTree.sHistoryHandlers[winID][brsID].startRestorePhase();
  sStore.setTabState(tab, JSON.stringify(ts));
}
