# frozen_string_literal: true

require "net/http"
require "openssl"
require "uri"

module KeepYourPrompts
  # Minimal GET with persistent connections (one Net::HTTP per host, keep-alive),
  # gzip, and HTTPS_PROXY/NO_PROXY honoured for https URLs. Used from one thread at a time.
  class HTTP
    Response = Struct.new(:status, :body, :etag, keyword_init: true)

    ERRORS = [
      IOError, SystemCallError, SocketError, Timeout::Error, OpenSSL::SSL::SSLError,
      Net::HTTPBadResponse, Net::ProtocolError, Zlib::Error
    ].freeze

    def initialize(connect_timeout:, request_timeout:, user_agent:)
      @connect_timeout = connect_timeout
      @request_timeout = request_timeout
      @user_agent = user_agent
      @conns = {}
    end

    # Raises KeepYourPrompts::HTTP::Failure when no HTTP status was received.
    def get(url, etag: nil, token: nil)
      uri = URI(url)
      req = Net::HTTP::Get.new(uri)
      req["User-Agent"] = @user_agent
      req["Accept"] = "*/*"
      req["If-None-Match"] = etag if etag && !etag.empty?
      req["Authorization"] = "Bearer #{token}" if token && !token.empty?
      res = connection(uri).request(req)
      Response.new(status: res.code.to_i, body: res.body.to_s.b, etag: res["etag"].to_s)
    rescue *ERRORS => e
      drop(uri) if uri
      raise Failure, "#{e.class.name.split("::").last}: #{e.message}"
    end

    # Forget connections without closing them (after fork: the parent still uses the sockets).
    def reset!
      @conns = {}
    end

    def close
      @conns.each_value { |c| c.finish if c.started? }
    rescue *ERRORS
      nil
    ensure
      @conns = {}
    end

    class Failure < StandardError; end

    private

    def connection(uri)
      key = [uri.scheme, uri.host, uri.port]
      conn = @conns[key]
      return conn if conn&.started?

      proxy = uri.find_proxy
      conn = Net::HTTP.new(uri.host, uri.port, proxy&.host, proxy&.port, proxy&.user, proxy&.password)
      conn.use_ssl = uri.scheme == "https"
      conn.open_timeout = @connect_timeout
      conn.read_timeout = @request_timeout
      conn.write_timeout = @request_timeout
      conn.ssl_timeout = @connect_timeout if conn.use_ssl?
      conn.keep_alive_timeout = 30
      conn.start
      @conns[key] = conn
    end

    def drop(uri)
      conn = @conns.delete([uri.scheme, uri.host, uri.port])
      conn&.finish if conn&.started?
    rescue *ERRORS
      nil
    end
  end
end
