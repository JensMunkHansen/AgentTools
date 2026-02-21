PREFIX ?= $(HOME)/.local/bin

install:
	mkdir -p $(PREFIX)
	ln -sf $(CURDIR)/chatgpt $(PREFIX)/chatgpt
	@echo "Installed: $(PREFIX)/chatgpt -> $(CURDIR)/chatgpt"

uninstall:
	rm -f $(PREFIX)/chatgpt
	@echo "Removed: $(PREFIX)/chatgpt"
